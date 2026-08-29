#!/usr/bin/env bash
# AccountHub 一键部署脚本（Debian 12 / 13）
# 用法：sudo bash install.sh
# 可选环境变量：PORT（默认 21117）、APP_DIR（默认 /opt/account-hub）
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/account-hub}"
PORT="${PORT:-21117}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 sudo 运行：sudo bash install.sh"
  exit 1
fi

echo "==> 安装目录：${APP_DIR}"
mkdir -p "${APP_DIR}/static" "${APP_DIR}/data"
install -m 755 "${SRC_DIR}/server.py"          "${APP_DIR}/server.py"
install -m 644 "${SRC_DIR}/static/index.html"  "${APP_DIR}/static/index.html"
[ -f "${SRC_DIR}/README.md" ] && install -m 644 "${SRC_DIR}/README.md" "${APP_DIR}/README.md" || true

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
Environment=PORT=${PORT}
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
echo "完成。访问入口: http://<服务器公网IP>:${PORT}"
echo "常用命令："
echo "  查看日志   journalctl -u account-hub -f"
echo "  重启服务   sudo systemctl restart account-hub"
echo "  放行端口   sudo ufw allow ${PORT}/tcp   （或到云厂商安全组放行 TCP ${PORT}）"
echo "  开启令牌   echo '你的令牌' | sudo tee ${APP_DIR}/token.txt   （删除该文件即关闭）"
