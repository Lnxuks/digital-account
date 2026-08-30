#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 4 轮：安全与协议层测试（请求走私 / 注入 / 路径穿越 / 异常方法）。

运行：python3 -m unittest discover -s tests -v
"""
import http.client
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import ServerHarness, new_item, server  # noqa: E402


def first_failed(e):
    """第一次请求就异常时的标记，便于在断言信息里看清是哪一步出问题。"""
    return "first-request-failed:%s" % type(e).__name__


class SecurityTest(ServerHarness, unittest.TestCase):

    def host_port(self):  # noqa: D102
        return "127.0.0.1", self.httpd.server_address[1]

    def reuse_after(self, method, path, body, headers=None):
        """在同一条 keep-alive 连接上先发一个异常请求，再发一个正常请求，返回第二次的结果。"""
        host, port = self.host_port()
        conn = http.client.HTTPConnection(host, port, timeout=10)
        try:
            conn.request(method, path, body, headers or {})
            resp = conn.getresponse()
            first = resp.status
            resp.read()
        except (http.client.HTTPException, OSError) as e:
            conn.close()
            return None, first_failed(e)
        try:
            conn.request("GET", "/api/health")
            resp2 = conn.getresponse()
            resp2.read()
            return first, "status:%d" % resp2.status
        except http.client.RemoteDisconnected:
            return first, "closed"          # 服务端主动断开
        except http.client.BadStatusLine as e:
            return first, "bad-status:%s" % e
        except OSError as e:
            return first, "conn-err:%s" % type(e).__name__
        finally:
            conn.close()


    # ---------- 请求体超限后的连接处理 ----------
    def test_oversized_body_does_not_corrupt_connection(self):
        """超限 body 若不读完就响应，keep-alive 上后续请求会解析错位（请求走私温床）。"""
        big = b'{"name":"' + b'x' * (server.MAX_BODY + 1024) + b'"}'
        first, second = self.reuse_after("POST", "/api/items", big,
                                         {"Content-Type": "application/json"})
        self.assertEqual(first, 413, "超限请求应返回 413，实际 %s" % first)
        self.assertEqual(second, "status:200",
                         "超限 body 读完后连接应可继续复用，实际：%s" % second)

    def test_malformed_json_keeps_connection(self):
        """JSON 解析失败时 body 已读完，连接可以复用。"""
        first, second = self.reuse_after("POST", "/api/items", b'{"name": ',
                                         {"Content-Type": "application/json"})
        self.assertEqual(first, 400)
        self.assertEqual(second, "status:200")

    def test_unauthorized_with_body_does_not_corrupt_connection(self):
        """鉴权失败时也要把 body 读完，否则残留字节会污染 keep-alive 连接。"""
        with open(server.TOKEN_PATH, "w", encoding="utf-8") as f:
            f.write("s3cret-token\n")
        first, second = self.reuse_after("POST", "/api/items", b'{"name":"x"}',
                                         {"Content-Type": "application/json"})
        self.assertEqual(first, 401)
        self.assertEqual(second, "status:401",
                         "鉴权失败后连接应仍可用，实际：%s" % second)

    def test_bad_path_with_body_does_not_corrupt_connection(self):
        first, second = self.reuse_after("PUT", "/api/items/", b'{"amount":1}',
                                         {"Content-Type": "application/json"})
        self.assertEqual(first, 404)
        self.assertEqual(second, "status:200",
                         "路径错误后连接应仍可用，实际：%s" % second)

    # ---------- 路径穿越 ----------
    def test_path_traversal_variants_blocked(self):
        for path in ("/../server.py", "/../../etc/passwd", "/..%2fserver.py",
                     "/%2e%2e%2fserver.py", "/....//server.py", "/static/../../server.py",
                     "/./../requirements.txt"):
            code, data = self.req("GET", path)
            self.assertEqual(code, 404, "穿越路径 %s 应 404" % path)
            if isinstance(data, dict):
                self.assertNotIn("import", json.dumps(data))

    # ---------- 注入 ----------
    def test_sql_injection_stored_literally(self):
        self.clear_items()
        payload = "'; DROP TABLE items;--"
        code, data = self.req("POST", "/api/items", new_item(payload))
        self.assertEqual(code, 200)
        self.assertEqual(data["item"]["name"], payload)
        code, data = self.req("GET", "/api/items")
        self.assertEqual(code, 200, "表不能被注入语句删掉")
        self.assertEqual(len(data["items"]), 1)

    def test_injection_in_order_by_position(self):
        """PUT 的字段名白名单不能被污染。"""
        self.clear_items()
        _, created = self.req("POST", "/api/items", new_item("注入测试"))
        item_id = created["item"]["id"]
        # 未知字段被白名单忽略（没有可更新字段 → 400），绝不能被拼进 SQL
        code, _ = self.req("PUT", "/api/items/%d" % item_id, {"amount; DROP TABLE items": 1})
        self.assertEqual(code, 400)
        code, data = self.req("GET", "/api/items")
        self.assertEqual(code, 200)
        self.assertEqual(len(data["items"]), 1)

    def test_header_injection_not_reflected(self):
        self.clear_items()
        code, data = self.req("POST", "/api/items",
                              new_item("X\r\nInjected: 1", note="a\r\nSet-Cookie: x=1"))
        self.assertEqual(code, 200)
        import urllib.request
        with urllib.request.urlopen(self.base + "/api/items", timeout=10) as resp:
            self.assertIsNone(resp.headers.get("Injected"))
            self.assertIsNone(resp.headers.get("Set-Cookie"))

    # ---------- 异常方法 ----------
    def test_unsupported_method_returns_501(self):
        for method in ("OPTIONS", "PATCH", "TRACE"):
            code, _ = self.raw_req(method, "/api/items", b"{}",
                                   {"Content-Type": "application/json"})
            self.assertEqual(code, 501, "%s 应返回 501" % method)

    # ---------- 令牌细节 ----------
    def test_token_prefix_is_case_sensitive(self):
        with open(server.TOKEN_PATH, "w", encoding="utf-8") as f:
            f.write("s3cret-token\n")
        code, _ = self.req("GET", "/api/items", raw_token="bearer s3cret-token")
        self.assertEqual(code, 401)

    def test_token_allows_surrounding_spaces(self):
        with open(server.TOKEN_PATH, "w", encoding="utf-8") as f:
            f.write("s3cret-token\n")
        code, _ = self.req("GET", "/api/items", raw_token="Bearer   s3cret-token  ")
        self.assertEqual(code, 200)

    def test_empty_token_file_disables_auth(self):
        with open(server.TOKEN_PATH, "w", encoding="utf-8") as f:
            f.write("   \n")           # 只有空白 = 未启用
        code, _ = self.req("GET", "/api/items")
        self.assertEqual(code, 200)

    # ---------- 静态资源边界 ----------
    def test_static_no_dir_listing_and_no_source(self):
        """目录路径不能列目录，任何情况下都不能把服务端源码吐出来。

        注：Windows 文件系统不区分大小写，/JS/core.js 会命中；Linux 下才是 404。
        两种都接受，重点是内容安全。
        """
        for path in ("/JS/core.js", "/js/", "/css/", "/static/"):
            code, text = self.raw_req("GET", path, b"")
            self.assertIn(code, (200, 404), "%s 返回了意外的 %d" % (path, code))
            self.assertNotIn("import sqlite3", text, "%s 泄露了服务端源码" % path)
            self.assertNotIn("<html", text.lower(), "%s 不应返回页面" % path)
            if code == 404:
                self.assertIn("not found", text)

    def test_source_not_served(self):
        code, _ = self.req("GET", "/../server.py")
        self.assertEqual(code, 404)
        code, _ = self.req("GET", "/server.py")
        self.assertEqual(code, 404)


if __name__ == "__main__":
    unittest.main()
