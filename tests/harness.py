#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测试脚手架：在临时目录里起一个真实的 AccountHub 服务。

供 tests/ 下的多个测试文件复用，不会碰项目里真实的 data/account.db。
"""
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
import server  # noqa: E402


def new_item(name="测试项目", **kw):
    item = {
        "name": name,
        "type": "expense",
        "category": "streaming",
        "amount": 25.0,
        "cycle": "monthly",
        "charge_day": 12,
        "start_date": "2026-01-01",
        "active": 1,
        "note": "",
    }
    item.update(kw)
    return item


class ServerHarness:
    """起服务 -> 发请求 -> 关服务。子类再继承 unittest.TestCase。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="accounthub-test-")
        server.DATA_DIR = os.path.join(cls.tmp, "data")
        server.DB_PATH = os.path.join(server.DATA_DIR, "account.db")
        server.BACKUP_DIR = os.path.join(server.DATA_DIR, "backups")
        server.TOKEN_PATH = os.path.join(cls.tmp, "token.txt")
        os.makedirs(server.DATA_DIR, exist_ok=True)
        cls.reset_conn()
        server.init_db()

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.request_queue_size = 128
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @staticmethod
    def reset_conn():
        if server._conn is not None:
            try:
                server._conn.close()
            except Exception:
                pass
            server._conn = None

    def setUp(self):
        with server._fail_lock:
            server._failures.clear()
        if os.path.exists(server.TOKEN_PATH):
            os.remove(server.TOKEN_PATH)

    # ---------- 请求封装 ----------
    def req(self, method, path, body=None, token=None, raw_token=None, headers=None):
        url = self.base + path
        data = None if body is None else json.dumps(body).encode("utf-8")
        r = urllib.request.Request(url, data=data, method=method)
        r.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            r.add_header(k, v)
        if token is not None or raw_token is not None:
            r.add_header("Authorization", raw_token or ("Bearer " + token))
        try:
            with urllib.request.urlopen(r, timeout=15) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            payload = e.read().decode("utf-8", "replace")
            try:
                payload = json.loads(payload)
            except ValueError:
                pass
            return e.code, payload

    def raw_req(self, method, path, data, headers=None):
        """直接发原始字节，用于畸形输入测试。"""
        url = self.base + path
        r = urllib.request.Request(url, data=data, method=method)
        for k, v in (headers or {}).items():
            r.add_header(k, v)
        try:
            with urllib.request.urlopen(r, timeout=15) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    def clear_items(self):
        self.req("POST", "/api/import", {"items": []})
