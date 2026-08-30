#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AccountHub 后端基础功能测试（CRUD / 分页 / 鉴权 / 导入备份 / 错误不外泄）。

运行：python3 -m unittest discover -s tests -v
"""
import json
import os
import sys
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import ServerHarness, new_item, server  # noqa: E402


class AccountHubTest(ServerHarness, unittest.TestCase):

    # ---------- 基础 ----------
    def test_health(self):
        code, data = self.req("GET", "/api/health")
        self.assertEqual(code, 200)
        self.assertTrue(data["ok"])

    def test_static_index_and_assets(self):
        for path, needle in (("/", "AccountHub"), ("/js/core.js", "const CATS"),
                             ("/css/app.css", "--accent")):
            url = self.base + path
            with urllib.request.urlopen(url, timeout=10) as resp:
                body = resp.read().decode("utf-8")
                self.assertEqual(resp.status, 200)
                self.assertIn(needle, body)

    def test_path_traversal_blocked(self):
        code, _ = self.req("GET", "/../server.py")
        self.assertEqual(code, 404)

    # ---------- 增删改查 ----------
    def test_crud_with_path_id(self):
        self.clear_items()
        code, data = self.req("POST", "/api/items", new_item("会员A"))
        self.assertEqual(code, 200)
        item_id = data["item"]["id"]

        code, data = self.req("GET", "/api/items")
        self.assertEqual(code, 200)
        self.assertEqual(len(data["items"]), 1)
        self.assertEqual(data["total"], 1)

        code, data = self.req("PUT", "/api/items/%d" % item_id, {"amount": 39.9})
        self.assertEqual(code, 200)
        self.assertAlmostEqual(data["item"]["amount"], 39.9)

        code, _ = self.req("DELETE", "/api/items/%d" % item_id)
        self.assertEqual(code, 200)
        code, _ = self.req("DELETE", "/api/items/%d" % item_id)
        self.assertEqual(code, 404)

    def test_legacy_query_id_still_works(self):
        self.clear_items()
        _, data = self.req("POST", "/api/items", new_item("兼容测试"))
        item_id = data["item"]["id"]
        code, data = self.req("PUT", "/api/items?id=%d" % item_id, {"note": "旧写法"})
        self.assertEqual(code, 200)
        self.assertEqual(data["item"]["note"], "旧写法")

    def test_validation_errors(self):
        code, data = self.req("POST", "/api/items", new_item(name=""))
        self.assertEqual(code, 400)
        self.assertIn("名称", data["error"])

        code, _ = self.req("POST", "/api/items", new_item(cycle="decade"))
        self.assertEqual(code, 400)

        code, _ = self.req("POST", "/api/items", new_item(charge_day=40))
        self.assertEqual(code, 400)

        code, _ = self.req("POST", "/api/items", new_item(start_date="2026/01/01"))
        self.assertEqual(code, 400)

    def test_batch_delete(self):
        self.clear_items()
        ids = []
        for i in range(3):
            _, data = self.req("POST", "/api/items", new_item("批量%d" % i))
            ids.append(data["item"]["id"])
        code, data = self.req("POST", "/api/batch-delete", {"ids": ids[:2]})
        self.assertEqual(code, 200)
        self.assertEqual(data["count"], 2)
        _, data = self.req("GET", "/api/items")
        self.assertEqual(len(data["items"]), 1)

    # ---------- 分页 ----------
    def test_pagination(self):
        self.clear_items()
        for i in range(5):
            self.req("POST", "/api/items", new_item("分页%d" % i))
        code, data = self.req("GET", "/api/items?limit=2&offset=1")
        self.assertEqual(code, 200)
        self.assertEqual(len(data["items"]), 2)
        self.assertEqual(data["total"], 5)
        self.assertEqual(data["offset"], 1)

        code, _ = self.req("GET", "/api/items?limit=abc")
        self.assertEqual(code, 400)

    # ---------- 令牌与限流 ----------
    def test_token_required(self):
        with open(server.TOKEN_PATH, "w", encoding="utf-8") as f:
            f.write("s3cret-token\n")
        code, _ = self.req("GET", "/api/items")
        self.assertEqual(code, 401)
        code, _ = self.req("GET", "/api/items", token="wrong-token")
        self.assertEqual(code, 401)
        code, data = self.req("GET", "/api/items", token="s3cret-token")
        self.assertEqual(code, 200)

    def test_rate_limit_after_failures(self):
        old = server.MAX_AUTH_FAIL
        server.MAX_AUTH_FAIL = 3
        try:
            with open(server.TOKEN_PATH, "w", encoding="utf-8") as f:
                f.write("s3cret-token\n")
            for _ in range(server.MAX_AUTH_FAIL - 1):
                code, _ = self.req("GET", "/api/items", token="bad")
                self.assertEqual(code, 401)
            # 第 MAX_AUTH_FAIL 次失败即触发封禁，此后即便令牌正确也拒绝
            code, _ = self.req("GET", "/api/items", token="bad")
            self.assertEqual(code, 429)
            code, data = self.req("GET", "/api/items", token="s3cret-token")
            self.assertEqual(code, 429)
            self.assertIn("频繁", data["error"])
        finally:
            server.MAX_AUTH_FAIL = old

    # ---------- 导入与备份 ----------
    def test_import_creates_backup(self):
        self.req("POST", "/api/import", {"items": [new_item("导入前")]})
        code, data = self.req("POST", "/api/import",
                              {"items": [new_item("导入后1"), new_item("导入后2")]})
        self.assertEqual(code, 200)
        self.assertEqual(data["count"], 2)
        self.assertTrue(data.get("backup"))
        self.assertTrue(os.path.isdir(server.BACKUP_DIR))

        _, data = self.req("GET", "/api/items")
        self.assertEqual(len(data["items"]), 2)

    def test_import_rejects_bad_record(self):
        code, data = self.req("POST", "/api/import", {"items": [new_item(name="")]})
        self.assertEqual(code, 400)
        self.assertIn("第 1 条", data["error"])

    # ---------- 错误不外泄 ----------
    def test_internal_error_not_leaked(self):
        original = server.db_read
        server.db_read = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("内部细节-不应外泄"))
        try:
            code, data = self.req("GET", "/api/items")
        finally:
            server.db_read = original
        self.assertEqual(code, 500)
        self.assertNotIn("内部细节-不应外泄", json.dumps(data, ensure_ascii=False))
        self.assertEqual(data["error"], "服务器内部错误")

    # ---------- 存储 ----------
    def test_wal_enabled(self):
        mode = server.db_read("PRAGMA journal_mode")[0][0]
        self.assertEqual(mode.lower(), "wal")


if __name__ == "__main__":
    unittest.main()
