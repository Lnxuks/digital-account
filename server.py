#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AccountHub · 个人数字账本（后端服务）
- 纯 Python 3 标准库实现，无需 pip 安装任何依赖（Debian 13 自带 python3 + sqlite3）
- 数据存储：SQLite（data/account.db）
- 默认监听 0.0.0.0:21117，可用环境变量 HOST / PORT 覆盖
- 可选访问令牌：在本文件同目录放置 token.txt（内容为令牌字符串）后立即启用，
  所有 /api 请求需带 Authorization: Bearer <令牌>；删除 token.txt 即关闭，无需重启
"""
import json
import os
import sqlite3
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "account.db")
TOKEN_PATH = os.path.join(BASE_DIR, "token.txt")

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "21117"))

os.makedirs(DATA_DIR, exist_ok=True)
_write_lock = threading.Lock()

CYCLES = ("weekly", "monthly", "quarterly", "yearly", "usage", "onetime")
TYPES = ("expense", "income")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
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


def load_token():
    """每次请求实时读取：新建/删除 token.txt 立即生效，无需重启服务。"""
    try:
        with open(TOKEN_PATH, "r", encoding="utf-8") as f:
            t = f.read().strip()
            return t or None
    except OSError:
        return None


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
        if amt < 0 or amt > 1e9:
            raise ValueError("金额需在 0 - 10 亿之间")
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


class Handler(BaseHTTPRequestHandler):
    server_version = "AccountHub/1.0"
    protocol_version = "HTTP/1.1"

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
    def _send(self, code, data: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _authed(self):
        token = load_token()
        if not token:
            return True
        return self.headers.get("Authorization", "") == "Bearer " + token

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length <= 0 or length > 2_000_000:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def _qid(self):
        qs = parse_qs(urlparse(self.path).query)
        try:
            return int(qs.get("id", [""])[0])
        except ValueError:
            return None

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
        with open(fp, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", self.MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    # ---------- 路由 ----------
    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            if not self._authed():
                self._json(401, {"error": "unauthorized"})
                return
            if u.path == "/api/health":
                self._json(200, {"ok": True, "time": datetime.now().isoformat(timespec="seconds")})
                return
            if u.path in ("/api/items", "/api/export"):
                with get_db() as conn:
                    rows = conn.execute(
                        "SELECT * FROM items ORDER BY type, category, active DESC, id"
                    ).fetchall()
                items = [dict(r) for r in rows]
                payload = {"items": items}
                if u.path == "/api/export":
                    payload["exported_at"] = datetime.now().isoformat(timespec="seconds")
                self._json(200, payload)
                return
            self._json(404, {"error": "not found"})
            return
        self._serve_static(u.path)

    def do_HEAD(self):
        u = urlparse(self.path)
        if u.path.startswith("/api/"):
            if not self._authed():
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, {"ok": True})
            return
        self._serve_static(u.path, head_only=True)

    def do_POST(self):
        u = urlparse(self.path)
        if not self._authed():
            self._json(401, {"error": "unauthorized"})
            return
        body = self._body()
        if body is None:
            self._json(400, {"error": "请求体不是合法 JSON"})
            return
        try:
            self._route_post(u, body)
        except Exception as e:  # noqa: BLE001 - 统一兜底，避免直接断连
            self._json(500, {"error": "服务器内部错误: %s" % e})

    def _route_post(self, u, body):
        if u.path == "/api/items":
            try:
                fields = sanitize(body, partial=False)
            except ValueError as e:
                self._json(400, {"error": str(e)})
                return
            try:
                with _write_lock, get_db() as conn:
                    cur = conn.execute(
                        """INSERT INTO items
                           (name, category, type, amount, cycle, charge_day, start_date, active, note)
                           VALUES (:name,:category,:type,:amount,:cycle,:charge_day,:start_date,:active,:note)""",
                        fields,
                    )
                    row = conn.execute("SELECT * FROM items WHERE id=?", (cur.lastrowid,)).fetchone()
            except Exception as e:  # noqa: BLE001
                self._json(500, {"error": "服务器内部错误: %s" % e})
                return
            self._json(200, {"item": dict(row)})
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
                with _write_lock, get_db() as conn:
                    conn.execute("DELETE FROM items")
                    for f in cleaned:
                        conn.execute(
                            """INSERT INTO items
                               (name, category, type, amount, cycle, charge_day, start_date, active, note)
                               VALUES (:name,:category,:type,:amount,:cycle,:charge_day,:start_date,:active,:note)""",
                            f,
                        )
                    if cleaned:
                        conn.execute(
                            "UPDATE sqlite_sequence SET seq=(SELECT MAX(id) FROM items) WHERE name='items'"
                        )
            except Exception as e:  # noqa: BLE001
                self._json(500, {"error": "服务器内部错误: %s" % e})
                return
            self._json(200, {"ok": True, "count": len(cleaned)})
            return
        self._json(404, {"error": "not found"})

    def do_PUT(self):
        u = urlparse(self.path)
        if not self._authed():
            self._json(401, {"error": "unauthorized"})
            return
        if u.path != "/api/items":
            self._json(404, {"error": "not found"})
            return
        item_id = self._qid()
        if item_id is None:
            self._json(400, {"error": "缺少 id 参数"})
            return
        body = self._body()
        if body is None:
            self._json(400, {"error": "请求体不是合法 JSON"})
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
            with _write_lock, get_db() as conn:
                cur = conn.execute("UPDATE items SET %s WHERE id=:id" % sets, fields)
                if cur.rowcount == 0:
                    self._json(404, {"error": "项目不存在"})
                    return
                row = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        except Exception as e:  # noqa: BLE001 - 统一兜底，避免直接断连
            self._json(500, {"error": "服务器内部错误: %s" % e})
            return
        self._json(200, {"item": dict(row)})

    def do_DELETE(self):
        u = urlparse(self.path)
        if not self._authed():
            self._json(401, {"error": "unauthorized"})
            return
        if u.path != "/api/items":
            self._json(404, {"error": "not found"})
            return
        item_id = self._qid()
        if item_id is None:
            self._json(400, {"error": "缺少 id 参数"})
            return
        with _write_lock, get_db() as conn:
            cur = conn.execute("DELETE FROM items WHERE id=?", (item_id,))
            if cur.rowcount == 0:
                self._json(404, {"error": "项目不存在"})
                return
        self._json(200, {"ok": True})


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    protected = "（已启用访问令牌）" if load_token() else ""
    print("AccountHub 已启动: http://%s:%d %s" % (HOST, PORT, protected), flush=True)
    print("数据文件: %s" % DB_PATH, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
