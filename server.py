#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AccountHub · 个人数字账本（后端服务）
- 纯 Python 3 标准库实现，无需 pip 安装任何依赖（Debian 13 自带 python3 + sqlite3）
- 数据存储：SQLite（data/account.db，已开启 WAL）
- 默认监听 0.0.0.0:21117，可用环境变量 HOST / PORT 覆盖
- 可选访问令牌：放置 token.txt（内容为令牌字符串）后立即启用，删除即关闭，无需重启

环境变量：
  HOST / PORT        监听地址与端口（默认 0.0.0.0:21117）
  TOKEN_FILE         令牌文件路径（优先级最高）
  AH_TRUST_PROXY=1   启用后按 X-Forwarded-For 识别客户端（仅在反代后使用）
  AH_MAX_AUTH_FAIL   令牌连续失败上限，默认 10
  AH_BLOCK_SECONDS   超限后封禁秒数，默认 300
  AH_BACKUP_KEEP     导入前自动备份保留份数，默认 10
"""
import hmac
import json
import logging
import math
import os
import re
import signal
import sqlite3
import sys
import threading
import time
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
# 数据目录可用 AH_DATA_DIR 覆盖：容器里把卷挂到 /data，数据就留在镜像之外
DATA_DIR = os.environ.get("AH_DATA_DIR") or os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "account.db")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")


def resolve_token_path():
    """令牌文件查找顺序：TOKEN_FILE 环境变量 > /etc/account-hub/token.txt > 项目目录 token.txt"""
    env = os.environ.get("TOKEN_FILE")
    if env:
        return env
    system = "/etc/account-hub/token.txt"
    if os.path.isfile(system):
        return system
    return os.path.join(BASE_DIR, "token.txt")


TOKEN_PATH = resolve_token_path()

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "21117"))

TRUST_PROXY = os.environ.get("AH_TRUST_PROXY", "") in ("1", "true", "True")
MAX_AUTH_FAIL = int(os.environ.get("AH_MAX_AUTH_FAIL", "10"))
BLOCK_SECONDS = int(os.environ.get("AH_BLOCK_SECONDS", "300"))
FAIL_WINDOW = 600          # 失败计数窗口（秒）
BACKUP_KEEP = int(os.environ.get("AH_BACKUP_KEEP", "10"))
MAX_BODY = 2_000_000

os.makedirs(DATA_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s %(levelname)s %(message)s",
)
LOG = logging.getLogger("account_hub")

CYCLES = ("weekly", "monthly", "quarterly", "yearly", "usage", "onetime")
TYPES = ("expense", "income")

# ---------------------------------------------------------------- 数据库

_conn = None
_db_lock = threading.RLock()   # 统一串行化所有 DB 访问，配合 WAL 避免 database is locked


def get_db():
    """进程内共享连接（check_same_thread=False），所有访问由 _db_lock 串行化。"""
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=15)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        _conn.execute("PRAGMA busy_timeout=15000")
        _conn.execute("PRAGMA foreign_keys=ON")
    return _conn


def init_db():
    with _db_lock:
        conn = get_db()
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS items (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                category    TEXT NOT NULL DEFAULT 'other',
                type        TEXT NOT NULL DEFAULT 'expense',
                amount      REAL NOT NULL DEFAULT 0,
                cycle       TEXT NOT NULL DEFAULT 'monthly',
                charge_day  INTEGER,
                start_date  TEXT,
                active      INTEGER NOT NULL DEFAULT 1,
                note        TEXT DEFAULT '',
                created_at  TEXT DEFAULT (datetime('now','localtime'))
            )
            """
        )
        conn.commit()


def close_db():
    """停服时把 WAL 落盘并关闭连接。

    README 推荐的恢复方式是"停服后用 db 文件覆盖"，若 -wal 残留在那儿
    会被新数据混进来，所以退出前先 checkpoint 并干净关闭。
    """
    global _conn
    with _db_lock:
        if _conn is None:
            return
        try:
            _conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except Exception:  # noqa: BLE001
            pass
        try:
            _conn.close()
        except Exception:  # noqa: BLE001
            pass
        _conn = None


def db_read(sql, params=()):
    with _db_lock:
        return get_db().execute(sql, params).fetchall()


def db_write(fn):
    """在锁内执行 fn(conn)，成功提交、失败回滚。"""
    with _db_lock:
        conn = get_db()
        try:
            result = fn(conn)
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise


def backup_db():
    """导入前用 sqlite backup API 做一份一致性快照，并裁剪旧备份。"""
    if not os.path.isfile(DB_PATH):
        return None
    os.makedirs(BACKUP_DIR, exist_ok=True)
    # 带微秒：同一秒内的两次导入若同名，后一份会覆盖前一份，等于丢了一次快照
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    dst_path = os.path.join(BACKUP_DIR, "account-%s.db" % stamp)
    dst = sqlite3.connect(dst_path)
    try:
        with _db_lock:
            get_db().backup(dst)
    finally:
        dst.close()
    files = sorted(
        (f for f in os.listdir(BACKUP_DIR) if f.startswith("account-") and f.endswith(".db")),
        reverse=True,
    )
    for old in files[BACKUP_KEEP:]:
        try:
            os.remove(os.path.join(BACKUP_DIR, old))
        except OSError:
            pass
    return dst_path


# ---------------------------------------------------------------- 令牌与限流

def load_token():
    """每次请求实时读取：新建/删除 token.txt 立即生效，无需重启服务。"""
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as f:
            t = f.read().strip()
            return t or None
    except OSError:
        return None


_failures = {}          # ip -> [count, first_ts, blocked_until]
_fail_lock = threading.Lock()


def _now():
    return time.monotonic()


def is_blocked(ip):
    with _fail_lock:
        rec = _failures.get(ip)
        if not rec:
            return False
        if rec[2] and _now() < rec[2]:
            return True
        if rec[2] and _now() >= rec[2]:
            del _failures[ip]
        return False


def note_failure(ip):
    """记录一次鉴权失败，超过阈值则封禁一段时间；顺带清扫过期记录，避免字典无限膨胀。"""
    now = _now()
    with _fail_lock:
        for key in [k for k, v in _failures.items()
                    if k != ip and now - v[1] > FAIL_WINDOW
                    and not (v[2] and now < v[2])]:
            del _failures[key]
        rec = _failures.get(ip)
        if not rec or now - rec[1] > FAIL_WINDOW:
            rec = [0, now, 0]
        rec[0] += 1
        if rec[0] >= MAX_AUTH_FAIL:
            rec[2] = now + BLOCK_SECONDS
        _failures[ip] = rec
        return rec[0] >= MAX_AUTH_FAIL


def note_success(ip):
    with _fail_lock:
        _failures.pop(ip, None)


def _valid_date(s):
    try:
        datetime.strptime(s, "%Y-%m-%d")
        return True
    except (TypeError, ValueError):
        return False


def sanitize(body, partial=False):
    """校验并归一化字段。partial=True 时只处理提交里出现的字段（用于 PUT）。"""
    out = {}
    full = not partial

    if full or "name" in body:
        name = str(body.get("name", "")).strip()
        if not name:
            raise ValueError("名称不能为空")
        out["name"] = name[:100]

    if full or "type" in body:
        t = body.get("type", "expense")
        if t not in TYPES:
            raise ValueError("类型不合法（expense / income）")
        out["type"] = t

    if full or "category" in body:
        cat = str(body.get("category", "")).strip()[:40]
        out["category"] = cat or "other"

    if full or "amount" in body:
        try:
            amt = round(float(body.get("amount", 0)), 2)
        except (TypeError, ValueError):
            raise ValueError("金额必须是数字")
        # NaN / Infinity 必须拦住：一旦入库，导出的 JSON 会含非法字面量，前端解析即崩
        if not math.isfinite(amt) or amt < 0 or amt > 1e9:
            raise ValueError("金额需是 0 - 10 亿之间的有效数字")
        out["amount"] = amt

    if full or "cycle" in body:
        c = body.get("cycle", "monthly")
        if c not in CYCLES:
            raise ValueError("计费周期不合法")
        out["cycle"] = c

    if full or "charge_day" in body:
        cd = body.get("charge_day")
        if cd in (None, "", "null"):
            out["charge_day"] = None
        else:
            try:
                cd = int(cd)
            except (TypeError, ValueError):
                raise ValueError("扣费日必须是 1-31 的整数")
            if not 1 <= cd <= 31:
                raise ValueError("扣费日需在 1-31 之间")
            out["charge_day"] = cd

    if full or "start_date" in body:
        sd = body.get("start_date") or None
        if sd is not None and not _valid_date(sd):
            raise ValueError("开始日期格式应为 YYYY-MM-DD")
        out["start_date"] = sd

    if full or "active" in body:
        out["active"] = 1 if body.get("active") in (1, True, "1", "true") else 0

    if full or "note" in body:
        out["note"] = str(body.get("note", ""))[:500]

    return out


INSERT_SQL = """
INSERT INTO items (name, category, type, amount, cycle, charge_day, start_date, active, note)
VALUES (:name,:category,:type,:amount,:cycle,:charge_day,:start_date,:active,:note)
"""

ITEM_PATH_RE = re.compile(r"^/api/items/(\d+)$")


class Handler(BaseHTTPRequestHandler):
    server_version = "AccountHub/1.1"
    protocol_version = "HTTP/1.1"
    timeout = 30

    MIME = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".json": "application/json; charset=utf-8",
    }

    # ---------- 基础工具 ----------
    def log_message(self, fmt, *args):
        LOG.info("%s %s", self.client_address[0] if self.client_address else "-", fmt % args)

    def client_ip(self):
        if TRUST_PROXY:
            fwd = self.headers.get("X-Forwarded-For", "")
            if fwd:
                return fwd.split(",")[0].strip()
        return self.client_address[0] if self.client_address else "unknown"

    def _base_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if self.close_connection:
            # 明确告知客户端这条连接不再复用，避免它把残留的请求体当成下一个响应
            self.send_header("Connection", "close")

    def _send(self, code, data: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._base_headers()
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _err(self, code, msg, exc=None):
        """对外只给通用文案，异常详情只进日志。"""
        if exc is not None:
            LOG.error("%s %s -> %s\n%s", self.command, self.path, msg,
                      "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
        self._json(code, {"error": msg})

    def _authed(self):
        """只做判定不写响应，返回 'ok' / 'unauthorized' / 'blocked'。"""
        token = load_token()
        if not token:
            return "ok"
        ip = self.client_ip()
        if is_blocked(ip):
            return "blocked"
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return "blocked" if note_failure(ip) else "unauthorized"
        ok = hmac.compare_digest(header[len("Bearer "):].strip(), token)
        if not ok:
            return "blocked" if note_failure(ip) else "unauthorized"
        note_success(ip)
        return "ok"

    def _guard(self, head_only=False):
        """统一鉴权入口：放行返回 True，否则响应已发出并返回 False。"""
        try:
            status = self._authed()
        except Exception as e:  # noqa: BLE001
            self._err(500, "服务器内部错误", e)
            return False
        if status == "ok":
            return True
        if status == "blocked":
            code, msg = 429, "尝试过于频繁，请稍后再试"
        else:
            code, msg = 401, "unauthorized"
        if head_only:
            self._send(code, b"", "application/json; charset=utf-8")
        else:
            self._json(code, {"error": msg})
        return False

    def _body_error_response(self):
        if self._body_error == "too_large":
            self._json(413, {"error": "请求体超过 %d 字节上限" % MAX_BODY})
        elif self._body_error == "bad_json":
            self._json(400, {"error": "请求体不是合法 JSON"})
        elif self._body_error == "bad_length":
            self._json(400, {"error": "Content-Length 不合法"})
        else:
            self._json(400, {"error": "请求体不能为空"})

    def _drain_body(self):
        """把请求体完整读出来。必须在任何提前返回之前调用。

        鉴权失败、路径错误等情况若不读完就响应，残留字节会被当成下一个请求，
        在 keep-alive 连接上造成协议错位（请求走私）。
        """
        self._body_error = None
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._body_error = "bad_length"
            self.close_connection = True
            return None
        if length <= 0:
            self._body_error = "empty"
            return None
        if length > MAX_BODY:
            # 必须把超限的字节读完再丢弃：留在 socket 里会被当成下一个请求，
            # 造成协议错位（请求走私）；直接断连则会让客户端收不到清晰的错误。
            left = length
            while left > 0:
                chunk = self.rfile.read(min(left, 65536))
                if not chunk:
                    break
                left -= len(chunk)
            self._body_error = "too_large"
            return None
        return self.rfile.read(length)

    def _decode_body(self, raw):
        """把已读出的字节解析成 JSON。"""
        if raw is None:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._body_error = "bad_json"
            return None

    def _item_id(self, path, query):
        """支持 /api/items/12 与兼容 /api/items?id=12 两种写法。"""
        m = ITEM_PATH_RE.match(path)
        if m:
            return int(m.group(1))
        qs = parse_qs(query)
        try:
            raw = qs.get("id", [""])[0]
            return int(raw) if raw else None
        except ValueError:
            return None

    @staticmethod
    def _paging(query):
        qs = parse_qs(query)
        limit = offset = None
        try:
            if qs.get("limit", [""])[0]:
                limit = min(int(qs["limit"][0]), 500)
                if limit < 1:
                    return None, None, "分页参数不合法"
            if qs.get("offset", [""])[0]:
                offset = int(qs["offset"][0])
                if offset < 0:
                    return None, None, "分页参数不合法"
        except ValueError:
            return None, None, "分页参数不合法"
        return limit, offset, None

    # ---------- 静态文件 ----------
    def _static_path(self, path):
        if path in ("/", "/index.html"):
            return os.path.join(STATIC_DIR, "index.html")
        rel = os.path.normpath(path.lstrip("/"))
        if rel.startswith("..") or os.path.isabs(rel):
            return None
        return os.path.join(STATIC_DIR, rel)

    def _serve_static(self, path, head_only=False):
        fp = self._static_path(path)
        if fp is None or not os.path.isfile(fp):
            self._json(404, {"error": "not found"})
            return
        ext = os.path.splitext(fp)[1].lower()
        try:
            st = os.stat(fp)
            etag = 'W/"%x-%x"' % (int(st.st_mtime), st.st_size)
        except OSError:
            st, etag = None, None
        # 前端三个 js + css 每次刷新都全量传，命中缓存直接回 304
        if etag and self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self._base_headers()
            self.end_headers()
            return
        with open(fp, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", self.MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        if etag:
            self.send_header("ETag", etag)
        self._base_headers()
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    # ---------- 路由 ----------
    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            if not self._guard():
                return
            try:
                self._route_get(u)
            except Exception as e:  # noqa: BLE001
                self._err(500, "服务器内部错误", e)
            return
        try:
            self._serve_static(u.path)
        except Exception as e:  # noqa: BLE001
            self._err(500, "服务器内部错误", e)

    def _route_get(self, u):
        if u.path == "/api/health":
            self._json(200, {"ok": True, "time": datetime.now().isoformat(timespec="seconds")})
            return
        if u.path == "/api/export":
            # 导出必须全量：被分页截断会生成一份残缺的备份
            rows = db_read("SELECT * FROM items ORDER BY type, category, active DESC, id")
            items = [dict(r) for r in rows]
            self._json(200, {
                "items": items,
                "total": len(items),
                "exported_at": datetime.now().isoformat(timespec="seconds"),
            })
            return
        if u.path == "/api/items":
            limit, offset, err = self._paging(u.query)
            if err:
                self._json(400, {"error": err})
                return
            rows = db_read("SELECT * FROM items ORDER BY type, category, active DESC, id")
            items = [dict(r) for r in rows]
            total = len(items)
            if limit is not None or offset is not None:
                start = offset or 0
                end = total if limit is None else start + limit
                items = items[start:end]
            payload = {"items": items, "total": total}
            if limit is not None:
                payload["limit"] = limit
            if offset:
                payload["offset"] = offset
            self._json(200, payload)
            return
        self._json(404, {"error": "not found"})

    def do_HEAD(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            # HEAD 不允许有响应体，否则 keep-alive 下会把 body 当成下一个请求的头
            if not self._guard(head_only=True):
                return
            self._send(200, b"", "application/json; charset=utf-8")
            return
        try:
            self._serve_static(u.path, head_only=True)
        except Exception as e:  # noqa: BLE001
            self._err(500, "服务器内部错误", e)

    def do_POST(self):
        u = urlparse(self.path)
        raw = self._drain_body()
        if not self._guard():
            return
        body = self._decode_body(raw)
        if body is None:
            self._body_error_response()
            return
        if not isinstance(body, dict):
            # 数组 / 字符串 / 数字进来会在 .get() 上抛 AttributeError，必须挡在 400 这一层
            self._json(400, {"error": "请求体必须是 JSON 对象"})
            return
        try:
            self._route_post(u, body)
        except Exception as e:  # noqa: BLE001
            self._err(500, "服务器内部错误", e)

    def _route_post(self, u, body):
        if u.path == "/api/items":
            try:
                fields = sanitize(body, partial=False)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            def _insert(conn):
                cur = conn.execute(INSERT_SQL, fields)
                return conn.execute("SELECT * FROM items WHERE id=?",
                                    (cur.lastrowid,)).fetchone()

            try:
                row = db_write(_insert)
            except Exception as e:  # noqa: BLE001
                self._err(500, "服务器内部错误，写入失败", e)
                return
            self._json(200, {"item": dict(row)})
            return

        if u.path == "/api/batch-delete":
            ids = body.get("ids")
            if not isinstance(ids, list) or not ids:
                self._json(400, {"error": "ids 需为非空数组"})
                return
            cleaned = []
            for v in ids:
                try:
                    n = int(v)
                except (TypeError, ValueError):
                    self._json(400, {"error": "ids 必须都是整数"})
                    return
                if n <= 0:
                    self._json(400, {"error": "ids 必须都是正整数"})
                    return
                cleaned.append(n)
            try:
                def _del(conn):
                    cur = conn.execute(
                        "DELETE FROM items WHERE id IN (%s)" % ",".join("?" * len(cleaned)),
                        cleaned,
                    )
                    return cur.rowcount
                count = db_write(_del)
            except Exception as e:  # noqa: BLE001
                self._err(500, "服务器内部错误，删除失败", e)
                return
            self._json(200, {"ok": True, "count": count})
            return

        if u.path == "/api/import":
            items = body.get("items")
            if not isinstance(items, list):
                self._json(400, {"error": "导入数据需包含 items 数组"})
                return
            cleaned = []
            for i, it in enumerate(items):
                try:
                    cleaned.append(sanitize(it, partial=False))
                except ValueError as e:
                    self._json(400, {"error": "第 %d 条记录有误：%s" % (i + 1, e)})
                    return
            try:
                backup = backup_db()

                def _imp(conn):
                    conn.execute("DELETE FROM items")
                    for f in cleaned:
                        conn.execute(INSERT_SQL, f)
                    if cleaned:
                        conn.execute(
                            "UPDATE sqlite_sequence SET seq=(SELECT MAX(id) FROM items) "
                            "WHERE name='items'"
                        )
                    return len(cleaned)
                count = db_write(_imp)
            except Exception as e:  # noqa: BLE001
                self._err(500, "服务器内部错误，导入失败", e)
                return
            payload = {"ok": True, "count": count}
            if backup:
                payload["backup"] = os.path.basename(backup)
            self._json(200, payload)
            return

        self._json(404, {"error": "not found"})

    def do_PUT(self):
        u = urlparse(self.path)
        raw = self._drain_body()
        if not self._guard():
            return
        if u.path != "/api/items" and not ITEM_PATH_RE.match(u.path):
            self._json(404, {"error": "not found"})
            return
        item_id = self._item_id(u.path, u.query)
        if item_id is None:
            self._json(400, {"error": "缺少 id 参数"})
            return
        body = self._decode_body(raw)
        if body is None:
            self._body_error_response()
            return
        if not isinstance(body, dict):
            self._json(400, {"error": "请求体必须是 JSON 对象"})
            return
        try:
            fields = sanitize(body, partial=True)
        except ValueError as e:
            self._json(400, {"error": str(e)})
            return
        if not fields:
            self._json(400, {"error": "没有需要更新的字段"})
            return
        sets = ", ".join("%s=:%s" % (k, k) for k in fields)
        fields["id"] = item_id
        try:
            def _upd(conn):
                cur = conn.execute("UPDATE items SET %s WHERE id=:id" % sets, fields)
                if cur.rowcount == 0:
                    return None
                return conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
            row = db_write(_upd)
        except Exception as e:  # noqa: BLE001
            self._err(500, "服务器内部错误，更新失败", e)
            return
        if row is None:
            self._json(404, {"error": "项目不存在"})
            return
        self._json(200, {"item": dict(row)})

    def do_DELETE(self):
        u = urlparse(self.path)
        self._drain_body()
        if not self._guard():
            return
        if u.path != "/api/items" and not ITEM_PATH_RE.match(u.path):
            self._json(404, {"error": "not found"})
            return
        item_id = self._item_id(u.path, u.query)
        if item_id is None:
            self._json(400, {"error": "缺少 id 参数"})
            return
        try:
            count = db_write(
                lambda conn: conn.execute("DELETE FROM items WHERE id=?", (item_id,)).rowcount
            )
        except Exception as e:  # noqa: BLE001
            self._err(500, "服务器内部错误，删除失败", e)
            return
        if count == 0:
            self._json(404, {"error": "项目不存在"})
            return
        self._json(200, {"ok": True})


class Server(ThreadingHTTPServer):
    """监听队列默认只有 5，公网/高并发下会直接拒连；这里放大到 128。"""
    daemon_threads = True
    request_queue_size = 128


def main():
    init_db()
    server = Server((HOST, PORT), Handler)

    def _graceful_stop(signum, _frame):
        LOG.info("收到信号 %s，正在停止", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _graceful_stop)
        except (ValueError, OSError, AttributeError):
            pass

    protected = "（已启用访问令牌）" if load_token() else ""
    LOG.info("AccountHub 已启动: http://%s:%d %s", HOST, PORT, protected)
    LOG.info("数据文件: %s（WAL 模式；令牌文件: %s）", DB_PATH, TOKEN_PATH)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("收到退出信号，正在关闭")
    finally:
        server.server_close()
        close_db()
        LOG.info("已停止")


if __name__ == "__main__":
    main()
