#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 2 轮：并发与压力测试。

在临时目录起一个与生产配置一致的服务（不改动 request_queue_size，复现真实默认值），
跑四类场景，输出报告。发现任何 5xx / 连接失败 / 数据不一致即以非零码退出。

用法：python3 tools/stress_test.py
"""
import http.client
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402

TMP = tempfile.mkdtemp(prefix="accounthub-stress-")
server.DATA_DIR = os.path.join(TMP, "data")
server.DB_PATH = os.path.join(server.DATA_DIR, "account.db")
server.BACKUP_DIR = os.path.join(server.DATA_DIR, "backups")
server.TOKEN_PATH = os.path.join(TMP, "token.txt")
os.makedirs(server.DATA_DIR, exist_ok=True)
server.init_db()

# 与 main() 走同一条启动路径（生产配置）
httpd = server.Server(("127.0.0.1", 0), server.Handler)
PORT = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

problems = []
stats = {"ok": 0, "http_err": 0, "conn_err": 0, "codes": {}}


def record(code):
    stats["codes"][code] = stats["codes"].get(code, 0) + 1
    if code >= 500:
        stats["http_err"] += 1
    else:
        stats["ok"] += 1


def call(method, path, body=None, timeout=20):
    """每次新建连接，避免复用掩盖队列问题。"""
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    try:
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if payload else {}
        conn.request(method, path, payload, headers)
        resp = conn.getresponse()
        resp.read()
        record(resp.status)
        return resp.status
    except (ConnectionRefusedError, socket.timeout, OSError) as e:
        stats["conn_err"] += 1
        return "conn:%s" % type(e).__name__
    finally:
        conn.close()


def item(i, **kw):
    base = {"name": "压测项%d" % i, "type": "expense", "category": "streaming",
            "amount": 10 + i % 50, "cycle": "monthly", "charge_day": (i % 28) + 1,
            "start_date": "2026-01-%02d" % ((i % 28) + 1), "active": 1, "note": ""}
    base.update(kw)
    return base


def parallel(fn, items_, workers):
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(fn, items_))


print("=" * 62)
print("AccountHub 压力测试  端口 %d  队列长度 %d"
      % (PORT, httpd.request_queue_size))
print("=" * 62)

# ---------- 场景 1：并发创建 ----------
print("\n[1] 并发创建 100 条（20 线程）")
t0 = time.time()
call("POST", "/api/import", {"items": []})
res = parallel(lambda i: call("POST", "/api/items", item(i)), range(100), 20)
bad = [r for r in res if r != 200]
print("    耗时 %.2fs  异常响应: %s" % (time.time() - t0, bad[:5] or "无"))
if bad:
    problems.append("并发创建出现非 200：%s" % bad[:5])

conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
conn.request("GET", "/api/items")
total = json.loads(conn.getresponse().read())["total"]
conn.close()
print("    落库总数 %d（期望 100）" % total)
if total != 100:
    problems.append("并发创建丢数据：落库 %d 条，期望 100" % total)

# ---------- 场景 2：读写混合 ----------
print("\n[2] 读写混合（40 线程 × 15 次）")
conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=10)
conn.request("GET", "/api/items")
ids = [x["id"] for x in json.loads(conn.getresponse().read())["items"][:60]]
conn.close()


def mixed(i):
    op = i % 4
    if op == 0:
        return call("GET", "/api/items?limit=20")
    if op == 1:
        return call("POST", "/api/items", item(1000 + i, name="混合%d" % i))
    if op == 2:
        return call("PUT", "/api/items/%d" % ids[i % len(ids)], {"note": "n%d" % i})
    return call("GET", "/api/health")


t0 = time.time()
res = parallel(mixed, range(600), 40)
bad = [r for r in res if isinstance(r, str) or r >= 500]
print("    耗时 %.2fs  5xx/连接错误: %d 次" % (time.time() - t0, len(bad)))
if bad:
    problems.append("读写混合出现 %d 次 5xx/连接错误：%s" % (len(bad), list(set(bad))[:3]))

# ---------- 场景 3：突发连接 ----------
print("\n[3] 突发 300 个并发连接（队列长度 %d）" % httpd.request_queue_size)
before_conn = stats["conn_err"]
parallel(lambda i: call("GET", "/api/health", timeout=15), range(300), 300)
conn_err = stats["conn_err"] - before_conn
print("    连接失败/超时: %d 次" % conn_err)
if conn_err:
    problems.append("突发连接失败 %d 次（队列长度 %d 偏小）"
                    % (conn_err, httpd.request_queue_size))

# ---------- 场景 3b：对照实验，队列保持默认 5 ----------
print("\n[3b] 对照：队列保持默认 5 时的突发表现")
base = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
base_port = base.server_address[1]
threading.Thread(target=base.serve_forever, daemon=True).start()


def burst(port, n=300, workers=300):
    def one(_i):
        try:
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            c.request("GET", "/api/health")
            c.getresponse().read()
            c.close()
            return True
        except Exception:
            return False
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, range(n))).count(False)


base_fail = burst(base_port)
base.shutdown()
base.server_close()
print("    队列=5 时失败 %d/300 次（队列=128 时失败 %d 次）" % (base_fail, conn_err))

# ---------- 场景 4：大数据量 ----------
print("\n[4] 大数据量 2000 条")
big = [item(i, name="大数据%d" % i) for i in range(2000)]
t0 = time.time()
code = call("POST", "/api/import", {"items": big}, timeout=60)
print("    导入 %s  耗时 %.2fs" % (code, time.time() - t0))

conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=60)
t0 = time.time()
conn.request("GET", "/api/items")
body = conn.getresponse().read()
dt_full = time.time() - t0
conn.close()
conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=60)
t0 = time.time()
conn.request("GET", "/api/items?limit=50")
body_paged = conn.getresponse().read()
dt_paged = time.time() - t0
conn.close()
print("    全量响应 %.1f KB / %.3fs；分页 50 条 %.1f KB / %.3fs"
      % (len(body) / 1024, dt_full, len(body_paged) / 1024, dt_paged))
if dt_full > 1.0:
    problems.append("全量列表耗时 %.2fs，超过 1s（2000 条）" % dt_full)

httpd.shutdown()
httpd.server_close()
shutil.rmtree(TMP, ignore_errors=True)

print("\n" + "=" * 62)
print("响应码分布:", stats["codes"], " 连接错误:", stats["conn_err"])
if problems:
    print("\n发现问题：")
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print("\n未发现问题")
