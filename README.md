# AccountHub · 个人数字账本

自托管的个人数字账户与订阅管理面板：把视频会员、AI 订阅、云存储、水电燃气、API 按量消费、年费保险等所有周期性费用与收入记在一处，自动算出**每月固定支出、年化支出，以及每笔订阅本期的"剩余价值"**。

- 后端：纯 Python 3 标准库（Flask 都不用装），数据存 SQLite
- 前端：自包含单页（原生 HTML/CSS/JS，无外部 CDN 依赖）
- 部署：Debian 13 一键脚本 + systemd 开机自启，监听 `0.0.0.0:21117`

---

## 功能

- **费用分类管理**：16 类支出（影音娱乐 / 游戏娱乐 / AI 订阅 / API 按量 / 软件工具 / 云服务存储 / 通讯网络 / 水电燃气 / 房租物业 / 生活会员 / 出行交通 / 保险保障 / 教育学习 / 健康健身 / 金融费用 / 其他）+ 6 类收入（工资 / 利息理财 / 返现红包 / 副业接单 / 退款退还 / 其他）
- **6 种计费周期**：周付 / 月付 / 季付 / 年付 / 按量（月均预估）/ 一次性
- **剩余价值计算**：每个订阅按本期已过天数折算「已用价值 / 剩余价值 / 日均成本 / 下次扣费」
- **即将续费**：未来 30 天续费提醒（今天 / 明天 / N 天后）
- **分类占比**：月均支出的环形图 + 排行
- **关键指标**：本月固定支出、月均收入、每月结余、年化支出、在管项目数
- **数据安全**：导出 / 导入 JSON 备份；可选访问令牌（`token.txt`）

## 目录结构

```
account-hub/
├── server.py           # 后端：HTTP 服务 + REST API + SQLite（标准库实现）
├── static/index.html   # 前端：自包含单页应用（含 CSS / JS / 图标）
├── install.sh          # 一键部署脚本（写 systemd 服务并启动）
├── data/               # 运行后生成：account.db（SQLite 数据库）
└── token.txt           # 可选：手动创建后启用访问令牌
```

## Debian 13 部署步骤

```bash
# 1. 上传解压（本地打包好 account-hub.tar.gz 后）
scp account-hub.tar.gz user@服务器IP:/tmp/
ssh user@服务器IP
cd /tmp && tar -xzf account-hub.tar.gz

# 2. 一键安装（需要 sudo）
cd account-hub && sudo bash install.sh

# 3. 放行端口
sudo ufw allow 21117/tcp        # 用了 ufw 的话
# 云服务器（阿里云/腾讯云/AWS 等）还要在控制台安全组放行 TCP 21117 —— 最常见的"打不开"原因

# 4. 浏览器访问
http://<服务器公网IP>:21117
```

首次打开是空账本：点「载入示例数据」体验功能，或直接「新增项目」。

## 开启访问令牌（推荐，公网暴露时）

```bash
echo '一串只有你知道的口令' | sudo tee /opt/account-hub/token.txt
```

立即生效，无需重启。之后浏览器首次访问会要求输入令牌（保存在本机浏览器）。取消令牌：删除 `token.txt`。

> 服务是 HTTP 明文。长期公网使用建议：① 启用令牌；② 或在前面套一层 Caddy/Nginx 反代加 HTTPS。

## 日常运维

```bash
systemctl status account-hub        # 状态
journalctl -u account-hub -f        # 实时日志
sudo systemctl restart account-hub  # 重启
sudo systemctl disable --now account-hub  # 停止并取消自启
```

- **改端口**：编辑 `/etc/systemd/system/account-hub.service` 里 `Environment=PORT=xxxx`，然后 `sudo systemctl daemon-reload && sudo systemctl restart account-hub`
- **备份**：复制 `/opt/account-hub/data/account.db`，或页面上「导出」JSON
- **恢复**：页面「导入」JSON，或停服后用 db 文件覆盖
- **更新前端**：覆盖 `/opt/account-hub/static/index.html` 后刷新页面即可（无需重启）
- **更新后端**：覆盖 `server.py` 后 `sudo systemctl restart account-hub`

## 修改指南（想自己改样式 / 分类 / 文案）

| 想改什么 | 改哪里 |
|---|---|
| 支出/收入分类（增删、名字、颜色、图标） | `static/index.html` 顶部 JS 的 `CATS` 对象（颜色、`icon` 图标 id 都在这里） |
| 主题色（暖赭 #c96442） | `static/index.html` `<style>` 里 `:root` 的 `--accent` / `--accent-deep` |
| 计费周期说明文案 | JS 的 `CYCLE_HINT` / `CYCLES` |
| 示例数据 | JS 的 `DEMO` 数组 |
| 页面标题 / 品牌名 | `<title>` 与 `.brand` / `.m-brand` 文本 |
| 图标 | `<body>` 顶部的 `<symbol id="i-...">` SVG 雪碧图 |
| 默认端口 | `server.py` 的 `PORT` 默认值，或 systemd 的 `Environment=PORT=` |
| 数据库位置 | `server.py` 的 `DB_PATH` |

前端是单文件改完即生效；改 `server.py` 需要重启服务。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/items` | 全部项目 |
| POST | `/api/items` | 新增（JSON body） |
| PUT | `/api/items?id=N` | 部分更新 |
| DELETE | `/api/items?id=N` | 删除 |
| POST | `/api/import` | `{items:[...]}` 全量导入（覆盖） |
| GET | `/api/export` | 导出 `{exported_at, items}` |

字段模型：`name` 名称 · `category` 分类 key · `type` expense/income · `amount` 每期金额 · `cycle` weekly/monthly/quarterly/yearly/usage/onetime · `charge_day` 扣费日 1-31（月/季付可选）· `start_date` YYYY-MM-DD（周期项目必填，年付以此日期为周年锚点）· `active` 1/0 · `note` 备注。

剩余价值算法：`剩余价值 = 每期金额 × 本期剩余天数 ÷ 本期总天数`；本期以「开始日期 + 周期循环」向前后推算（月/季付的扣费日向月末钳制，如 31 号在 2 月取 28/29 号）。

## 质量说明

- 状态覆盖：加载骨架屏、首用空态（引导新增/示例）、筛选无结果空态、后端不可达错误态（可重试）、离线预览模式（未连后端时自动载入示例数据并明确提示）
- 表单校验：失焦后校验、出错即时重校验、字段级错误提示（`role=alert`）、提交中禁用按钮且保留输入
- 可访问性：语义地标（aside/nav/main/section）、表单 label 绑定、图标按钮 aria-label、`focus-visible` 焦点环、数字 tabular-nums、触控目标 ≥24px
- 响应式：桌面侧栏布局，≤960px 折叠为单列 + 顶栏品牌，表格横向滚动
- 安全：路径穿越防护、请求体大小限制、可选 Bearer 令牌、systemd 加固（NoNewPrivileges/PrivateTmp/ProtectSystem）

## 常见问题

- **公网打不开**：先在服务器本机 `curl http://127.0.0.1:21117/api/health` 确认服务活着，再查防火墙与**云安全组**是否放行 TCP 21117。
- **端口被占用**：`ss -tlnp | grep 21117` 查占用，改 `Environment=PORT=` 换端口。
- **开机自启**：`install.sh` 已 `systemctl enable`，重启服务器自动拉起。
- **想换 HTTPS**：用 Caddy 两行配置反代 `127.0.0.1:21117` 并自动签证书。
