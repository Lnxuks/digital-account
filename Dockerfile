# AccountHub · 个人数字账本
# 纯 Python 标准库，无第三方依赖，镜像只有 server.py + static/
FROM python:3.13-slim

LABEL org.opencontainers.image.title="AccountHub" \
      org.opencontainers.image.description="自托管个人订阅与固定支出账本" \
      org.opencontainers.image.source="https://example.com/account-hub"

# 时区必须设：日期计算（今天 / 剩余价值 / 下次扣费）用的是本地时间，
# 容器默认 UTC 会让国内用户的账期整体差 8 小时。按需改成你的时区。
ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=21117 \
    AH_DATA_DIR=/data

# 非 root 运行：uid/gid 10001，数据目录属主同步改掉
RUN groupadd --system --gid 10001 accounthub \
 && useradd --system --uid 10001 --gid 10001 --no-create-home accounthub \
 && mkdir -p /app /data \
 && chown -R accounthub:accounthub /data

WORKDIR /app
COPY --chown=accounthub:accounthub server.py ./
COPY --chown=accounthub:accounthub static/ ./static/
COPY --chown=accounthub:accounthub README.md ./

USER accounthub

# 数据卷：SQLite 库与自动快照都在这里
VOLUME ["/data"]
EXPOSE 21117

# 镜像里没有 curl，用 Python 标准库探活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT','21117'), timeout=3)"

# python 直接作为 PID 1，SIGTERM 由 server.py 捕获后优雅关闭（先落 WAL 再退出）
CMD ["python", "server.py"]
