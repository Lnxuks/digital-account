# AccountHub · 个人数字账本

自托管的个人数字账户与订阅管理面板：把视频会员、AI 订阅、云存储、水电燃气、API 按量消费、年费保险等所有周期性费用记在一处，自动算出**每月固定支出、年化支出，以及每笔订阅本期的"剩余价值"**。纯支出账本，专注订阅与固定费用管理。

- 后端：纯 Python 3 标准库（Flask 都不用装），数据存 SQLite（WAL 模式）
- 前端：自包含单页（原生 HTML/CSS/JS，无外部 CDN 依赖，已拆分为 css + 3 个 js 模块）
- 部署：Debian 13 一键脚本 + systemd 开机自启，监听 `0.0.0.0:21117`
- 安全：可选访问令牌（时序安全比较 + 失败限流）、对外不回显异常详情、导入前自动备份

> 服务本身是 HTTP 明文。公网部署请务必套一层 HTTPS 反代，见下方「启用 HTTPS」。

---

## 功能

- **费用分类管理**：16 类支出（影音娱乐 / 游戏娱乐 / AI 订阅 / API 按量 / 软件工具 / 云服务存储 / 通讯网络 / 水电燃气 / 房租物业 / 生活会员 / 出行交通 / 保险保障 / 教育学习 / 健康健身 / 金融费用 / 其他）
- **6 种计费周期**：周付 / 月付 / 季付 / 年付 / 按量（月均预估）/ 一次性
- **剩余价值计算**：每个订阅按本期已过天数折算「已用价值 / 剩余价值 / 日均成本 / 下次扣费」
- **即将续费**：未来 30 天续费提醒（今天 / 明天 / N 天后）
- **分类占比**：月均支出的环形图 + 排行
- **关键指标**：固定支出 / 周期订阅 / 按量预估 / 在管项目数 / 剩余价值；前三张卡都能切换「月均 · 季均 · 半年 · 年均」口径
- **数据安全**：导出 / 导入 JSON 备份；导入前自动生成数据库快照（`data/backups/`）
- **删除与批量清理**：行内删除、编辑弹窗内删除、表格多选批量删除（`POST /api/batch-delete`），均带确认提示

## 目录结构

```
account-hub/
├── server.py               # 后端：HTTP 服务 + REST API + SQLite（标准库实现）
├── static/
│   ├── index.html          # 页面骨架 + SVG 图标雪碧图
│   ├── css/app.css         # 全部样式
│   └── js/
│       ├── core.js         # 常量、状态、工具函数、周期计算、API 封装、示例数据
│       ├── render.js       # 渲染逻辑（KPI / 续费 / 趋势 / 剩余价值 / 项目表）
│       └── app.js          # 表单校验、数据操作、令牌、启动与事件绑定
├── install.sh              # 一键部署脚本（写 systemd 服务并启动，裸机用）
├── Dockerfile              # 容器镜像：python:3.13-slim，非 root 运行
├── docker-compose.yml      # Compose 部署：数据卷 + 健康检查 + 可选 Caddy 反代
├── .dockerignore           # 构建上下文排除项（数据与令牌不进镜像）
├── docs/
│   ├── Caddyfile           # Caddy HTTPS 反代示例
│   └── nginx-example.conf  # Nginx HTTPS 反代示例
├── tests/test_server.py    # 单元测试（python3 -m unittest）
├── tools/                  # 一次性维护脚本（前端拆分等）
├── data/                   # 运行后生成：account.db（SQLite）、backups/（自动快照）
├── archive/                # 历史版本前端快照（仅供回溯，不参与部署）
└── token.txt               # 可选：手动创建后启用访问令牌（默认未启用）
```

## Docker 部署（推荐，最简单）

```bash
# 1. 构建并启动（后台运行，数据存命名卷 account-hub-data）
docker compose up -d

# 2. 看状态与日志
docker compose ps
docker compose logs -f

# 3. 浏览器访问
http://<服务器IP>:21117
```

想用原生命令也可以：

```bash
docker build -t account-hub:1.1 .
docker run -d --name account-hub \
  -p 21117:21117 \
  -e TZ=Asia/Shanghai \
  -v account-hub-data:/data \
  --restart unless-stopped \
  account-hub:1.1
```

容器要点：

- **时区**：镜像默认 `TZ=Asia/Shanghai`。「今天 / 下次扣费 / 剩余价值」都按本地日期算，时区错了账期会整体偏移，请按实际地区调整。
- **数据**：库与自动快照都在卷里的 `/data`，升级镜像不会丢数据。
- **非 root**：以 uid 10001 运行。若改用宿主机目录挂载，需先 `sudo chown -R 10001:10001 ./data`。
- **优雅停止**：`python` 即 PID 1，收到 SIGTERM 会先落 WAL 再退出，不会损坏数据库。
- **令牌**：宿主机上 `echo '你的令牌' > token.txt && chmod 600 token.txt`，然后打开 `docker-compose.yml` 里那两行注释（挂载 + `TOKEN_FILE`），`docker compose up -d` 生效。
- **HTTPS**：`docker-compose.yml` 末尾有现成的 Caddy 反代配置，去掉注释、把域名换成你的即可。

运维命令：

```bash
docker compose restart              # 重启
docker compose down                 # 停止（卷保留）
docker compose pull && docker compose up -d   # 本地构建时无需 pull，重新 build 即可
docker compose build --no-cache     # 代码更新后重新构建镜像
docker run --rm -v account-hub-data:/data -v "$PWD":/backup alpine \
  tar -czf /backup/account-hub-backup.tar.gz -C /data .   # 备份数据卷
```

## Debian 13 部署步骤（裸机，不用 Docker）

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

`install.sh` 支持的环境变量（可重复执行，已有 `token.txt` 不会被覆盖）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_DIR` | `/opt/account-hub` | 安装目录 |
| `PORT` | `21117` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址，套反代后建议改 `127.0.0.1` |
| `BEHIND_PROXY` | `0` | 设为 `1` 启用 `X-Forwarded-For` 识别真实客户端 IP |
| `TOKEN_FILE` | `空` | 指定令牌文件路径 |

例：套反代时只听本机

```bash
sudo HOST=127.0.0.1 BEHIND_PROXY=1 bash install.sh
```

## 启用 HTTPS（公网部署必做）

服务是 HTTP 明文，令牌也会在网络上裸奔。请在前面加一层反代：

- **Caddy**（自动签证书）：改好域名后 `sudo cp docs/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`
- **Nginx + certbot**：见 `docs/nginx-example.conf`

套好反代后：把服务改为只听 `127.0.0.1`、开启 `AH_TRUST_PROXY=1`，防火墙只放行 80/443。

## 开启访问令牌（推荐，公网暴露时）

```bash
echo '一串只有你知道的口令' | sudo tee /opt/account-hub/token.txt
```

立即生效，无需重启。之后浏览器首次访问会要求输入令牌（保存在本机浏览器）。取消令牌：删除 `token.txt`。

令牌查找顺序：`TOKEN_FILE` 环境变量 → `/etc/account-hub/token.txt` → 安装目录下的 `token.txt`（建议放到 `/etc` 并用 `TOKEN_FILE` 指定，避免被打包带走）。

安全相关行为：

- 比较用 `hmac.compare_digest`（时序安全），且**每次请求实时读取**文件，改删即生效
- 连续失败超过 `AH_MAX_AUTH_FAIL`（默认 10）次，该 IP 被封禁 `AH_BLOCK_SECONDS`（默认 300）秒，返回 429
- 接口报错对外只返回通用文案，异常详情只写入 journald 日志

## 日常运维

```bash
systemctl status account-hub        # 状态
journalctl -u account-hub -f        # 实时日志（异常堆栈只在这里出现）
sudo systemctl restart account-hub  # 重启
sudo systemctl disable --now account-hub  # 停止并取消自启
```

- **改端口/监听地址**：`sudo HOST=127.0.0.1 PORT=8080 bash install.sh` 重新生成服务单元
- **备份**：复制 `/opt/account-hub/data/account.db`（连同 `-wal`/`-shm`），或页面上「导出」JSON
- **恢复**：页面「导入」JSON（导入前会自动快照到 `data/backups/`），或停服后用 db 文件覆盖——**覆盖前务必删掉 `account.db-wal` 与 `account.db-shm`**，否则残留的 WAL 会把旧数据混回来
- **更新前端**：覆盖 `static/` 下对应文件后刷新页面即可（无需重启）
- **更新后端**：覆盖 `server.py` 后 `sudo systemctl restart account-hub`

## 运行配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `21117` | 监听地址与端口 |
| `AH_DATA_DIR` | 项目下 `data/` | 数据目录（SQLite 与自动快照），容器里设为 `/data` |
| `TOKEN_FILE` | 见上 | 令牌文件路径 |
| `AH_TRUST_PROXY` | `0` | 反代后设为 `1`，按 `X-Forwarded-For` 限流 |
| `AH_MAX_AUTH_FAIL` | `10` | 令牌连续失败上限 |
| `AH_BLOCK_SECONDS` | `300` | 超限后封禁秒数 |
| `AH_BACKUP_KEEP` | `10` | 导入前自动快照保留份数 |

## 修改指南（想自己改样式 / 分类 / 文案）

| 想改什么 | 改哪里 |
|---|---|
| 支出/收入分类（增删、名字、颜色、图标） | `static/js/core.js` 的 `CATS` 对象 |
| 主题色、布局样式 | `static/css/app.css`（`:root` 里的 CSS 变量） |
| 计费周期说明文案 | `core.js` 的 `CYCLE_HINT` / `CYCLES` |
| 示例数据 | `core.js` 的 `DEMO` 数组 |
| 卡片 / 图表的渲染方式 | `static/js/render.js` |
| 表单校验、按钮行为、事件 | `static/js/app.js` |
| 页面标题 / 品牌名 | `static/index.html` 的 `<title>` 与 `.brand` / `.m-brand` |
| 图标 | `static/index.html` 顶部的 `<symbol id="i-...">` SVG 雪碧图 |
| 默认端口 / 数据库位置 | `server.py` 的 `PORT`、`DB_PATH` |

前端改完刷新即生效；改 `server.py` 需要重启服务。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/items` | 项目列表，支持 `?limit=&offset=`（返回 `total`），默认全量 |
| POST | `/api/items` | 新增（JSON body） |
| PUT | `/api/items/{id}` | 部分更新（兼容旧写法 `PUT /api/items?id=N`） |
| DELETE | `/api/items/{id}` | 删除（兼容 `DELETE /api/items?id=N`） |
| POST | `/api/batch-delete` | `{ids:[...]}` 批量删除 |
| POST | `/api/import` | `{items:[...]}` 全量导入（覆盖），导入前自动快照 |
| GET | `/api/export` | 导出 `{exported_at, items}` |

字段模型：`name` 名称 · `category` 分类 key · `type` 固定 expense（历史收入数据仍兼容展示，可在列表中删除）· `amount` 每期金额 · `cycle` weekly/monthly/quarterly/yearly/usage/onetime · `charge_day` 扣费日 1-31（月/季付可选）· `start_date` YYYY-MM-DD（周期项目必填，年付以此日期为周年锚点）· `active` 1/0 · `note` 备注。

剩余价值算法：`剩余价值 = 每期金额 × 本期剩余天数 ÷ 本期总天数`；本期以「开始日期 + 周期循环」向前后推算（月/季付的扣费日向月末钳制，如 31 号在 2 月取 28/29 号）。

## 测试

```bash
cd account-hub
python3 -m unittest discover -s tests -v
```

测试使用临时目录与临时数据库，不会碰到 `data/account.db`。

## 质量说明

- 状态覆盖：加载骨架屏、首用空态（引导新增/示例）、筛选无结果空态、后端不可达错误态（可重试）、离线预览模式（未连后端时自动载入示例数据并明确提示）、限流态（429 提示稍后再试）
- 表单校验：失焦后校验、出错即时重校验、字段级错误提示（`role=alert`）、提交中禁用按钮且保留输入
- 可访问性：语义地标（aside/nav/main/section）、表单 label 绑定、图标按钮 aria-label、`focus-visible` 焦点环、数字 tabular-nums、触控目标 ≥24px
- 响应式：桌面侧栏布局，≤960px 折叠为单列 + 顶栏品牌，表格横向滚动
- 安全：路径穿越防护、请求体上限 2MB（超限先读完再回 413，不留残留字节污染连接）、可选 Bearer 令牌（时序安全比较 + 失败限流）、错误不外泄异常、安全响应头、systemd 加固（NoNewPrivileges/PrivateTmp/ProtectSystem）
- 存储：SQLite WAL 模式 + busy_timeout，所有访问串行化，避免并发写冲突

## 常见问题

- **公网打不开**：先在服务器本机 `curl http://127.0.0.1:21117/api/health` 确认服务活着，再查防火墙与**云安全组**是否放行 TCP 21117。
- **端口被占用**：`ss -tlnp | grep 21117` 查占用，`sudo PORT=xxxx bash install.sh` 换端口。
- **页面提示「访问过于频繁」**：连续输错令牌触发了限流，等 5 分钟或重启服务即可解除。
- **导入后想反悔**：`data/backups/` 下有导入前的自动快照，停服后覆盖回 `account.db` 即可。
- **开机自启**：`install.sh` 已 `systemctl enable`，重启服务器自动拉起。
- **Docker 里日期/账期不对**：检查容器时区，`docker exec account-hub date` 应与本地一致，不一致就改 `TZ` 后重建。
- **Docker 挂载宿主机目录后启动失败**：多半是权限，卷属主必须是容器里的 uid 10001：`sudo chown -R 10001:10001 ./data`。
- **想换 HTTPS**：`docs/Caddyfile`（Caddy 自动签证书）或 `docs/nginx-example.conf`（Nginx + certbot）。

> `部署与使用指南.html` 是给非技术同学看的图文版，内容以本 README 为准；两者冲突时以 README 为准。
