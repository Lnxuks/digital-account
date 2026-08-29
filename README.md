# 数字账户 · 个人财务管理

一个纯前端、零依赖的个人数字账户管理应用：收入项、支出项、每月固定订阅、API 费用独立统计，并自动计算每月剩余价值。

## 功能

- **总览仪表盘**：本月收入 / 支出 / 订阅月均 / API 费用 / 剩余价值五张统计卡
- **收入项 / 支出项**：支持「每月固定」与「一次性」两种周期，带分类与备注
- **订阅费用**：按月 / 季 / 年计费，自动折算月均成本，计算下次续订日期与倒计时
- **API 费用**：单独一页统计各服务商（OpenAI、云厂商等）的月度开销、日均成本
- **近 6 个月收支趋势图**、支出分类构成、月度结余速览
- **数据管理**：JSON 导出 / 导入备份、示例数据、一键清空
- 深色 / 浅色模式，数据保存在浏览器 localStorage，无需任何后端

**剩余价值计算公式**：`本月剩余 = 本月收入 − 本月支出 − 订阅月均 − API 费用`

## 技术栈

纯 HTML + CSS + 原生 JavaScript，无任何外部依赖、无构建步骤、无后端 —— 直接被 nginx 等静态服务器托管即可。

## 目录结构

```
digital-account/
├── index.html                  # 入口页面
├── assets/
│   ├── style.css               # 样式（含深色模式）
│   └── app.js                  # 业务逻辑
└── deploy/
    └── nginx-digital-account.conf   # nginx 站点配置
```

## Debian 13 服务器部署

> ⚠️ **端口提醒**：TCP 端口取值范围是 1–65535，需求中的 `221117` 不是合法端口。
> 下文以 `22117` 为例，如需其他端口请同步修改 nginx 配置与防火墙放行规则。

### 1. 上传代码到服务器

在本地执行（把 `你的服务器IP` 换成实际 IP）：

```bash
scp -r ./digital-account 你的服务器IP:/tmp/digital-account
```

或使用 `git clone`（见下方 GitHub 同步部分）。

### 2. 安装 nginx 并部署

在服务器上以 root 或 sudo 执行：

```bash
sudo apt update && sudo apt install -y nginx
sudo mkdir -p /var/www/digital-account
sudo cp -r /tmp/digital-account/* /var/www/digital-account/
sudo chown -R www-data:www-data /var/www/digital-account
```

### 3. 配置站点

```bash
sudo cp /var/www/digital-account/deploy/nginx-digital-account.conf /etc/nginx/sites-available/digital-account
sudo ln -s /etc/nginx/sites-available/digital-account /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default   # 可选：移除默认站点
sudo nginx -t && sudo systemctl reload nginx
```

### 4. 放行防火墙端口

```bash
sudo apt install -y ufw
sudo ufw allow 22117/tcp
sudo ufw enable   # 若尚未启用
```

同时记得在云厂商控制台的**安全组**中放行 22117/TCP 端口。

### 5. 访问

浏览器打开：`http://你的服务器IP:22117`

### 更新版本

```bash
sudo cp -r 新代码/* /var/www/digital-account/
sudo systemctl reload nginx
```

## 同步到 GitHub

```bash
cd digital-account
git init
git add .
git commit -m "feat: 个人数字账户管理应用 v1"
git branch -M main
git remote add origin git@github.com:你的用户名/digital-account.git
git push -u origin main
```

服务器上则可以直接 `git clone` 部署：

```bash
sudo git clone https://github.com/你的用户名/digital-account.git /var/www/digital-account
```

## 数据说明

所有数据保存在**浏览器本地**（localStorage）：

- 不同浏览器 / 设备之间数据不互通，换设备前请在「数据管理」页导出 JSON 备份
- 清除浏览器数据会丢失记录，请养成定期备份的习惯
