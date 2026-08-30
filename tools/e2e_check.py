#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 5 轮：端到端回归 + 备份恢复演练 + 文档一致性核对。

在临时目录里跑完整业务流程，不碰真实的 data/account.db。
用法：python3 tools/e2e_check.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402

problems = []


def check(cond, label, detail=""):
    if cond:
        print("    OK   %s" % label)
    else:
        print("    FAIL %s %s" % (label, detail))
        problems.append(label + (" " + detail if detail else ""))


def start_server(data_dir):
    """用指定的数据目录起一个服务，返回 (base_url, httpd)。"""
    server.DATA_DIR = data_dir
    server.DB_PATH = os.path.join(data_dir, "account.db")
    server.BACKUP_DIR = os.path.join(data_dir, "backups")
    server.TOKEN_PATH = os.path.join(data_dir, "..", "token-none.txt")
    os.makedirs(data_dir, exist_ok=True)
    if server._conn is not None:
        try:
            server._conn.close()
        except Exception:
            pass
        server._conn = None
    server.init_db()
    httpd = server.Server(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return "http://127.0.0.1:%d" % httpd.server_address[1], httpd


def call(base, method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


TMP = tempfile.mkdtemp(prefix="accounthub-e2e-")
DATA = os.path.join(TMP, "data")
base, httpd = start_server(DATA)


def item(name, **kw):
    d = {"name": name, "type": "expense", "category": "ai", "amount": 100,
         "cycle": "monthly", "charge_day": 8, "start_date": "2026-01-08",
         "active": 1, "note": ""}
    d.update(kw)
    return d


print("=" * 62)
print("第 5 轮 · 端到端回归")
print("=" * 62)

# ---------- 1. 完整业务流程 ----------
print("\n[1] 完整业务流程")
code, r = call(base, "POST", "/api/items", item("新增-ChatGPT"))
check(code == 200 and r["item"]["name"] == "新增-ChatGPT", "新增项目")
iid = r["item"]["id"]

code, r = call(base, "PUT", "/api/items/%d" % iid, {"amount": 168})
check(code == 200 and r["item"]["amount"] == 168, "编辑金额")

code, r = call(base, "PUT", "/api/items/%d" % iid, {"active": 0})
check(code == 200 and r["item"]["active"] == 0, "停用项目")

code, _ = call(base, "POST", "/api/items", item("新增-网盘", category="cloud", amount=21))
code, data = call(base, "GET", "/api/items")
check(code == 200 and data["total"] == 2, "列表总数=2", str(data.get("total")))

code, data = call(base, "GET", "/api/export")
export_payload = data
check(code == 200 and len(data["items"]) == 2, "导出 2 条")

code, data = call(base, "POST", "/api/batch-delete", {"ids": [iid]})
check(code == 200 and data["count"] == 1, "批量删除 1 条")

# ---------- 2. 导出 -> 清空 -> 导入还原 ----------
print("\n[2] 导出 / 清空 / 导入还原")
code, _ = call(base, "POST", "/api/import", {"items": []})
code, data = call(base, "GET", "/api/items")
check(code == 200 and data["total"] == 0, "清空成功")

code, data = call(base, "POST", "/api/import", {"items": export_payload["items"]})
check(code == 200 and data["count"] == 2, "导入还原 2 条")
code, data = call(base, "GET", "/api/items")
restored = {x["name"] for x in data["items"]}
check(restored == {"新增-ChatGPT", "新增-网盘"}, "还原后的名称一致", str(restored))

# ---------- 3. 备份恢复演练 ----------
print("\n[3] 备份恢复演练")
code, data = call(base, "POST", "/api/import",
                  {"items": [item("恢复前-A"), item("恢复前-B")]})
check(code == 200 and data.get("backup"), "导入触发自动快照", str(data))

# 快照记的是"导入前"的状态：误导入这一次生成的快照，才是能回滚到的数据
code, wrong = call(base, "POST", "/api/import", {"items": [item("回滚前的错误数据")]})
check(code == 200 and wrong.get("backup"), "误导入也生成了快照")
code, data = call(base, "GET", "/api/items")
check(data["total"] == 1 and data["items"][0]["name"] == "回滚前的错误数据", "误导入已生效")

backup_name = wrong.get("backup")
backup_path = os.path.join(DATA, "backups", backup_name) if backup_name else None
check(bool(backup_path) and os.path.isfile(backup_path), "快照文件存在")

httpd.shutdown()
httpd.server_close()
server.close_db()          # 优雅停服：WAL 落盘并释放文件句柄

# 停服后用快照覆盖数据库（README 里写的恢复方式）
shutil.copy2(backup_path, os.path.join(DATA, "account.db"))
for suffix in ("-wal", "-shm"):
    side = os.path.join(DATA, "account.db" + suffix)
    if os.path.exists(side):
        os.remove(side)

base2, httpd2 = start_server(DATA)
code, data = call(base2, "GET", "/api/items")
names = sorted(x["name"] for x in data["items"])
check(code == 200 and names == ["恢复前-A", "恢复前-B"],
      "停服覆盖快照后数据回滚成功", str(names))
httpd2.shutdown()
httpd2.server_close()

# ---------- 4. 文档与实现一致性 ----------
print("\n[4] 文档与实现一致性")
readme = open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()

CANDIDATE_DIRS = ("", "static", "static/js", "static/css", "docs", "tools", "tests")

for rel in re.findall(r'`([a-zA-Z0-9_./-]+\.(?:py|js|css|html|sh|conf|Caddyfile|txt|md))`',
                      readme):
    # 跳过绝对路径（如 /etc/account-hub/token.txt）与运行时数据
    if rel.startswith("/") or rel.startswith("data/") or rel == "token.txt":
        continue
    # 目录树里会出现 core.js 这类简写，按候选目录找
    found = any(os.path.exists(os.path.join(ROOT, d, rel if d else rel))
                for d in CANDIDATE_DIRS)
    if not found:
        found = any(os.path.exists(os.path.join(ROOT, d, os.path.basename(rel)))
                    for d in CANDIDATE_DIRS)
    if not found:
        check(False, "README 引用的文件在仓库里找不到：%s" % rel)
print("    已核对 README 中引用的文件路径")

for env in ("HOST", "PORT", "TOKEN_FILE", "AH_DATA_DIR", "AH_TRUST_PROXY",
            "AH_MAX_AUTH_FAIL", "AH_BLOCK_SECONDS", "AH_BACKUP_KEEP"):
    check(env in readme, "README 记录了环境变量 %s" % env)
    check(env in open(os.path.join(ROOT, "server.py"), encoding="utf-8").read()
          or env in ("HOST", "PORT"), "server.py 实现了 %s" % env)

for api in ("/api/health", "/api/items", "/api/import", "/api/export", "/api/batch-delete"):
    check(api in readme, "README 记录了接口 %s" % api)

# install.sh 必须同步新的前端目录
install_sh = open(os.path.join(ROOT, "install.sh"), encoding="utf-8").read()
for needle in ("static/css/app.css", "static/js", "token.txt", "Environment=HOST"):
    check(needle in install_sh, "install.sh 处理了 %s" % needle)

# .gitignore 必须挡住数据与密钥
gitignore = open(os.path.join(ROOT, ".gitignore"), encoding="utf-8").read()
for needle in ("data/", "token.txt", "__pycache__"):
    check(needle in gitignore, ".gitignore 忽略了 %s" % needle)

# ---------- 5. Docker 配置核对 ----------
print("\n[5] Docker 配置核对")
srv_src = open(os.path.join(ROOT, "server.py"), encoding="utf-8").read()
dockerfile = open(os.path.join(ROOT, "Dockerfile"), encoding="utf-8").read()
compose = open(os.path.join(ROOT, "docker-compose.yml"), encoding="utf-8").read()
dockerignore = open(os.path.join(ROOT, ".dockerignore"), encoding="utf-8").read()

for src in re.findall(r"^COPY\s+(?:--chown=\S+\s+)?(\S+)\s+", dockerfile, re.M):
    check(os.path.exists(os.path.join(ROOT, src.rstrip("/"))),
          "Dockerfile COPY 的 %s 在仓库中存在" % src)

expose = re.search(r"^EXPOSE\s+(\d+)", dockerfile, re.M)
check(bool(expose) and int(expose.group(1)) == 21117, "EXPOSE 端口与默认 PORT 一致")

for env_name in re.findall(r"^\s+([A-Z][A-Z0-9_]*):", compose, re.M):
    if env_name == "TZ":
        continue
    check(env_name in srv_src, "compose 环境变量 %s 在 server.py 中生效" % env_name)

for needle in ("data/", "token.txt", ".git"):
    check(needle in dockerignore, ".dockerignore 排除了 %s" % needle)

check("AH_DATA_DIR" in srv_src, "server.py 支持 AH_DATA_DIR（容器挂卷要用）")
check("signal.SIGTERM" in srv_src, "server.py 处理 SIGTERM（容器停止时优雅关闭）")
check(not re.search(r"^USER\s+root", dockerfile, re.M), "容器不以 root 运行")

# ---------- 6. 模拟容器数据目录 ----------
print("\n[6] 模拟容器环境（AH_DATA_DIR 挂卷）")
container_data = os.path.join(TMP, "container-data")
env = dict(os.environ, AH_DATA_DIR=container_data)
proc = subprocess.run(
    [sys.executable, "-c", "import server; print(server.DB_PATH)"],
    cwd=ROOT, env=env, capture_output=True, text=True,
)
check(container_data.replace("\\", "/") in proc.stdout.replace("\\", "/"),
      "AH_DATA_DIR 环境变量生效", (proc.stdout.strip() or proc.stderr.strip()[:120]))

base3, httpd3 = start_server(container_data)
call(base3, "POST", "/api/items", item("容器数据落盘"))
check(os.path.isfile(os.path.join(container_data, "account.db")),
      "数据库写到 AH_DATA_DIR 指定的目录")
httpd3.shutdown()
httpd3.server_close()
server.close_db()

shutil.rmtree(TMP, ignore_errors=True)

print("\n" + "=" * 62)
if problems:
    print("发现问题 %d 项：" % len(problems))
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print("第 5 轮全部通过")
