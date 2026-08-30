#!/usr/bin/env bash
# AccountHub 一键部署脚本（Debian 12 / 13）
# 用法：sudo bash install.sh
# 可重复执行；已有 token.txt 不会被覆盖。
#
# 可选环境变量：
#   APP_DIR      安装目录（默认 /opt/account-hub）
#   HOST         监听地址（默认 0.0.0.0；套了反代建议改 127.0.0.1）
#   PORT         监听端口（默认 21117）
#   BEHIND_PROXY=1   服务在反代之后，启用 X-Forwarded-For 识别客户端（用于失败限流）
#   TOKEN_FILE   令牌文件路径（默认 ${APP_DIR}/token.txt）
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/account-hub}"
PORT="${PORT:-21117}"
HOST="${HOST:-0.0.0.0}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行：sudo bash install.sh"
  exit 1
fi

echo "==> 安装目录：${APP_DIR}（监听 ${HOST}:${PORT}）"
mkdir -p "${APP_DIR}/static/css" "${APP_DIR}/static/js" "${APP_DIR}/data"
install -m 755 "${SRC_DIR}/server.py"              "${APP_DIR}/server.py"
install -m 644 "${SRC_DIR}/static/index.html"      "${APP_DIR}/static/index.html"
install -m 644 "${SRC_DIR}/static/css/app.css"     "${APP_DIR}/static/css/app.css"
for f in "${SRC_DIR}"/static/js/*.js; do
  install -m 644 "$f" "${APP_DIR}/static/js/$(basename "$f")"
done
[ -f "${SRC_DIR}/README.md" ] && install -m 644 "${SRC_DIR}/README.md" "${APP_DIR}/README.md" || true

# 令牌文件：只在新装且源文件有实际内容时写入，绝不覆盖已有令牌
# （-s 只判断大小，仓库里的占位文件是一个换行符，必须再判一次去除空白后是否为空）
SRC_TOKEN=""
if [ -f "${SRC_DIR}/token.txt" ] && [ -n "$(tr -d '[:space:]' < "${SRC_DIR}/token.txt" 2>/dev/null)" ]; then
  SRC_TOKEN="${SRC_DIR}/token.txt"
fi
if [ ! -f "${APP_DIR}/token.txt" ] && [ -n "${SRC_TOKEN}" ]; then
  echo "==> 写入令牌文件：${APP_DIR}/token.txt"
  install -m 600 "${SRC_TOKEN}" "${APP_DIR}/token.txt"
fi

ENV_LINES="Environment=PORT=${PORT}
Environment=HOST=${HOST}"
[ -n "${TOKEN_FILE:-}" ] && ENV_LINES="${ENV_LINES}
Environment=TOKEN_FILE=${TOKEN_FILE}"
[ "${BEHIND_PROXY:-0}" = "1" ] && ENV_LINES="${ENV_LINES}
Environment=AH_TRUST_PROXY=1"

echo "==> 写入 systemd 服务：/etc/systemd/system/account-hub.service"
cat > /etc/systemd/system/account-hub.service <<EOF
[Unit]
Description=AccountHub - personal digital account dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/python3 ${APP_DIR}/server.py
${ENV_LINES}
Restart=on-failure
RestartSec=3

# 加固：只写自己的目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now account-hub
sleep 1
systemctl --no-pager --lines=5 status account-hub || true

echo
if [ "${HOST}" = "0.0.0.0" ]; then
  echo "完成。访问入口: http://<服务器公网IP>:${PORT}"
  echo "（公网暴露请务必套 HTTPS 反代，参见 README「启用 HTTPS」一节）"
else
  echo "完成。服务仅监听 ${HOST}:${PORT}，请通过反代访问。"
fi
echo "常用命令："
echo "  查看日志   journalctl -u account-hub -f"
echo "  重启服务   sudo systemctl restart account-hub"
echo "  放行端口   sudo ufw allow ${PORT}/tcp   （或到云厂商安全组放行 TCP ${PORT}）"
echo "  开启令牌   echo '你的令牌' | sudo tee ${APP_DIR}/token.txt   （删除该文件即关闭）"
echo "  自动备份   ${APP_DIR}/data/backups/ （导入前自动生成，保留最近 ${AH_BACKUP_KEEP:-10} 份）"
