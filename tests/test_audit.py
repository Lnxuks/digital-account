#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 1 轮：后端健壮性审计（畸形输入 / 数值边界 / API 语义 / 限流回收）。

这些用例断言的是"应该发生什么"，跑挂了就说明有漏洞。
运行：python3 -m unittest discover -s tests -v
"""
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import ServerHarness, new_item, server  # noqa: E402


class RobustnessTest(ServerHarness, unittest.TestCase):

    # ---------- 非对象 / 畸形 JSON ----------
    def test_non_object_body_returns_400(self):
        for body in ("[]", '"just a string"', "123", "null", "true"):
            for path in ("/api/items", "/api/import", "/api/batch-delete"):
                code, data = self.raw_req("POST", path, body.encode("utf-8"),
                                          {"Content-Type": "application/json"})
                self.assertEqual(code, 400, "%s 收到 %s 应返回 400，实际 %d" % (path, body, code))

    def test_non_object_body_on_put_returns_400(self):
        code, _ = self.raw_req("PUT", "/api/items/1", b"[]",
                               {"Content-Type": "application/json"})
        self.assertEqual(code, 400)

    def test_broken_json_returns_400(self):
        code, data = self.raw_req("POST", "/api/items", b'{"name": "x", ',
                                  {"Content-Type": "application/json"})
        self.assertEqual(code, 400)
        self.assertIn("JSON", data)

    def test_missing_body_returns_400(self):
        code, _ = self.raw_req("POST", "/api/items", b"", {"Content-Type": "application/json"})
        self.assertEqual(code, 400)

    # ---------- 数值边界 ----------
    def test_nan_and_infinity_amount_rejected(self):
        """NaN / Infinity 若入库，导出 JSON 会出现非法字面量，前端 JSON.parse 直接崩。"""
        for raw in (b'{"name":"nan-item","amount":NaN}',
                    b'{"name":"inf-item","amount":Infinity}',
                    b'{"name":"neg-inf-item","amount":-Infinity}',
                    b'{"name":"huge-item","amount":1e999}'):
            code, _ = self.raw_req("POST", "/api/items", raw,
                                   {"Content-Type": "application/json"})
            self.assertEqual(code, 400, "%s 应被拒绝" % raw.decode())

    def test_stored_amount_is_finite_json(self):
        self.clear_items()
        self.req("POST", "/api/items", new_item("正常项", amount=19.9))
        _, data = self.req("GET", "/api/export")
        text = json.dumps(data, allow_nan=False)   # 有 NaN 会直接抛异常
        self.assertIn("19.9", text)

    def test_negative_and_huge_amount_rejected(self):
        code, _ = self.req("POST", "/api/items", new_item("负金额", amount=-1))
        self.assertEqual(code, 400)
        code, _ = self.req("POST", "/api/items", new_item("超大", amount=2e9))
        self.assertEqual(code, 400)

    # ---------- 字段长度与未知字段 ----------
    def test_long_fields_truncated(self):
        self.clear_items()
        code, data = self.req("POST", "/api/items",
                              new_item("名" * 300, note="注" * 900))
        self.assertEqual(code, 200)
        self.assertEqual(len(data["item"]["name"]), 100)
        self.assertEqual(len(data["item"]["note"]), 500)

    def test_unknown_fields_ignored(self):
        self.clear_items()
        code, data = self.req("POST", "/api/items",
                              new_item("多余字段", evil="x", id=9999))
        self.assertEqual(code, 200)
        self.assertNotIn("evil", data["item"])
        self.assertNotEqual(data["item"]["id"], 9999)

    # ---------- API 语义 ----------
    def test_export_ignores_paging(self):
        """导出必须全量，不能被 limit/offset 截断成半个备份。"""
        self.clear_items()
        for i in range(3):
            self.req("POST", "/api/items", new_item("导出%d" % i))
        code, data = self.req("GET", "/api/export?limit=1&offset=0")
        self.assertEqual(code, 200)
        self.assertEqual(len(data["items"]), 3)
        self.assertIn("exported_at", data)

    def test_limit_zero_rejected(self):
        code, _ = self.req("GET", "/api/items?limit=0")
        self.assertEqual(code, 400)

    def test_offset_beyond_total_returns_empty(self):
        self.clear_items()
        self.req("POST", "/api/items", new_item("只有一条"))
        code, data = self.req("GET", "/api/items?offset=999")
        self.assertEqual(code, 200)
        self.assertEqual(data["items"], [])
        self.assertEqual(data["total"], 1)

    def test_consecutive_imports_keep_separate_backups(self):
        """同一秒内连续导入两次，不能出现第二份快照覆盖第一份（否则等于没备份）。"""
        if not os.path.isdir(server.BACKUP_DIR):
            os.makedirs(server.BACKUP_DIR, exist_ok=True)
        for old in os.listdir(server.BACKUP_DIR):
            os.remove(os.path.join(server.BACKUP_DIR, old))
        self.req("POST", "/api/import", {"items": [new_item("第一版")]})
        _, first = self.req("POST", "/api/import", {"items": [new_item("第二版")]})
        _, second = self.req("POST", "/api/import", {"items": [new_item("第三版")]})
        self.assertTrue(first.get("backup"))
        self.assertTrue(second.get("backup"))
        self.assertNotEqual(first["backup"], second["backup"], "两次快照文件名不能相同")

        backups = sorted(os.listdir(server.BACKUP_DIR))
        self.assertEqual(len(backups), 3, "三次导入应留下三份快照，实际 %s" % backups)

        # 最老那份快照里不能出现后一次导入的内容
        import sqlite3
        oldest = os.path.join(server.BACKUP_DIR, backups[0])
        conn = sqlite3.connect(oldest)
        try:
            names = [r[0] for r in conn.execute("SELECT name FROM items")]
        finally:
            conn.close()
        self.assertNotIn("第二版", names, "最老的快照被后一次导入覆盖了")

    def test_put_without_fields_returns_400(self):
        self.clear_items()
        _, created = self.req("POST", "/api/items", new_item("空更新"))
        code, _ = self.req("PUT", "/api/items/%d" % created["item"]["id"], {})
        self.assertEqual(code, 400)

    def test_unknown_api_returns_404(self):
        code, _ = self.req("GET", "/api/nope")
        self.assertEqual(code, 404)
        code, _ = self.req("POST", "/api/nope", {"a": 1})
        self.assertEqual(code, 404)

    # ---------- 限流记录回收 ----------
    def test_block_expires(self):
        """封禁到期后应自动解除，否则一次输错就永久锁死。"""
        old_block, old_max = server.BLOCK_SECONDS, server.MAX_AUTH_FAIL
        server.BLOCK_SECONDS, server.MAX_AUTH_FAIL = 1, 1
        try:
            with open(server.TOKEN_PATH, "w", encoding="utf-8") as f:
                f.write("s3cret-token\n")
            code, _ = self.req("GET", "/api/items", token="bad")
            self.assertEqual(code, 429)
            time.sleep(1.2)
            code, _ = self.req("GET", "/api/items", token="s3cret-token")
            self.assertEqual(code, 200, "封禁到期后应恢复访问")
        finally:
            server.BLOCK_SECONDS, server.MAX_AUTH_FAIL = old_block, old_max

    def test_failure_records_do_not_grow_forever(self):
        """限流字典必须能回收，长时间运行不能无限膨胀。"""
        for i in range(5):
            server._failures["203.0.113.%d" % i] = [
                1, server._now() - server.FAIL_WINDOW - 10, 0]
        server.note_failure("198.51.100.9")   # 触发一次清扫
        # 过期的旧记录应被清掉，只留下刚记的这一条
        self.assertLessEqual(len(server._failures), 1)
        self.assertIn("198.51.100.9", server._failures)

    def test_proxy_client_ip_isolation(self):
        """反代后不同 X-Forwarded-For 应各自计次，不能因为共用回源 IP 一起被封。"""
        old = server.TRUST_PROXY
        server.TRUST_PROXY = True
        try:
            with open(server.TOKEN_PATH, "w", encoding="utf-8") as f:
                f.write("s3cret-token\n")
            for _ in range(2):
                self.req("GET", "/api/items", token="bad",
                         headers={"X-Forwarded-For": "198.51.100.1"})
            code, _ = self.req("GET", "/api/items", token="s3cret-token",
                               headers={"X-Forwarded-For": "198.51.100.2"})
            self.assertEqual(code, 200)
        finally:
            server.TRUST_PROXY = old

    # ---------- 头部与协议 ----------
    def test_security_headers_present(self):
        import urllib.request
        with urllib.request.urlopen(self.base + "/", timeout=10) as resp:
            self.assertEqual(resp.headers.get("X-Content-Type-Options"), "nosniff")
            self.assertEqual(resp.headers.get("Referrer-Policy"), "no-referrer")

    def test_head_returns_empty_body(self):
        """HEAD 带 body 会让 keep-alive 连接上的下一个请求解析错位。"""
        for path in ("/api/health", "/", "/js/app.js"):
            code, text = self.raw_req("HEAD", path, b"")
            self.assertEqual(code, 200, path)
            self.assertEqual(text, "", "%s 的 HEAD 响应不该有 body" % path)
        # 同一条连接上继续请求仍正常，说明协议没被污染
        code, data = self.req("GET", "/api/health")
        self.assertEqual(code, 200)
        self.assertTrue(data["ok"])

    def test_static_etag_and_304(self):
        """静态资源应带 ETag，命中时回 304 且不带 body。"""
        import urllib.error
        import urllib.request
        url = self.base + "/js/app.js"
        with urllib.request.urlopen(url, timeout=10) as resp:
            etag = resp.headers.get("ETag")
            first_len = len(resp.read())
        self.assertTrue(etag, "静态资源缺少 ETag")

        req = urllib.request.Request(url, headers={"If-None-Match": etag})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                code, body = resp.status, resp.read()
        except urllib.error.HTTPError as e:      # 304 会被 urllib 抛成 HTTPError
            code, body = e.code, b""
        self.assertEqual(code, 304)
        self.assertEqual(len(body), 0, "304 响应不能带 body")
        self.assertGreater(first_len, 0)

    def test_trailing_slash_item_path_not_found(self):
        code, _ = self.req("PUT", "/api/items/", {"amount": 1})
        self.assertEqual(code, 404)


if __name__ == "__main__":
    unittest.main()
