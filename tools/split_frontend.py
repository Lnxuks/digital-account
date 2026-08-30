#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性脚本：把 static/index.html 的 <style> 与 <script> 抽成独立文件。

用法：python3 tools/split_frontend.py
已完成拆分后本脚本可保留作为历史记录，也可直接删除。
"""
import io
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(BASE, "static", "index.html")
CSS_OUT = os.path.join(BASE, "static", "css", "app.css")
JS_DIR = os.path.join(BASE, "static", "js")

with io.open(HTML, "r", encoding="utf-8") as f:
    lines = f.readlines()

# 1-indexed 行号 -> 0-indexed 切片
def seg(a, b):
    return "".join(lines[a - 1:b])

CSS = seg(16, 239)                 # <style> 内容
JS_START = 449                     # <script> 第一行
JS = seg(449, 1328)
js_lines = JS.splitlines(True)

def jseg(a, b):
    """按原始文件行号取 JS 片段"""
    return "".join(js_lines[a - JS_START:b - JS_START + 1])

HEADER_STRICT = "'use strict';\n"

CORE = (
    HEADER_STRICT
    + "/* core.js · 基础常量、状态、工具函数、周期计算、API 封装、示例数据 */\n"
    + jseg(450, 594)      # 常量 / 状态 / 工具 / 周期计算 / API / DEMO
    + "\n" + jseg(1201, 1212)  # toast
)
RENDER = (
    HEADER_STRICT
    + "/* render.js · 全部渲染逻辑（KPI / 即将续费 / 分类趋势 / 剩余价值 / 项目表） */\n"
    + jseg(596, 972)
)
APP = (
    HEADER_STRICT
    + "/* app.js · 表单校验、数据操作、令牌、启动与事件绑定 */\n"
    + jseg(973, 1191)     # 表单 + 数据操作
    + "\n" + jseg(1193, 1199)  # 令牌弹窗
    + "\n" + jseg(1214, 1328)  # 启动 + 事件绑定
)

os.makedirs(os.path.dirname(CSS_OUT), exist_ok=True)
os.makedirs(JS_DIR, exist_ok=True)
with io.open(CSS_OUT, "w", encoding="utf-8", newline="") as f:
    f.write(CSS.strip() + "\n")
for name, content in (("core.js", CORE), ("render.js", RENDER), ("app.js", APP)):
    with io.open(os.path.join(JS_DIR, name), "w", encoding="utf-8", newline="") as f:
        f.write(content.rstrip() + "\n")

# 收缩 index.html：样式改为外链，脚本改为三个外链文件
out = lines[:14]                                   # 到注释结束（第 14 行）
out.append('<link rel="stylesheet" href="css/app.css">\n')
out.extend(lines[240:447])                         # </style> 之后到 <script> 之前
out.append('<script src="js/core.js"></script>\n')
out.append('<script src="js/render.js"></script>\n')
out.append('<script src="js/app.js"></script>\n')
out.extend(lines[1329:])                           # </script> 之后

with io.open(HTML, "w", encoding="utf-8", newline="") as f:
    f.writelines(out)

print("done: css=%d bytes, core=%d, render=%d, app=%d" % (
    len(CSS), len(CORE), len(RENDER), len(APP)))
