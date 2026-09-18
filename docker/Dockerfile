# agent_swarm 服务端镜像（多阶段构建：前端 → 运行时）
#
# 构建（项目根目录执行）:
#   docker build -t agent-swarm -f docker/Dockerfile .
#
# 运行:
#   docker run -d --name agent-swarm \
#     -p 8700:8700 \
#     -v agent-swarm-data:/app/data \
#     -e AGENT_SWARM_JWT_SECRET=change-me-in-production \
#     agent-swarm
#
#   # 访问 http://localhost:8700 （管理前端 + API + MCP 同端口）
#
# 数据卷: /app/data 持久化 SQLite 数据库与插件分发包

# ---------- 阶段 1: 构建管理前端 ----------
FROM node:22-alpine AS web-builder

WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
# vite build 产物在 /build/dist
RUN npm run build

# ---------- 阶段 2: Python 运行时 ----------
FROM python:3.12-slim

WORKDIR /app

# 依赖先行复制，充分利用构建缓存
# 先升级 pip：镜像内置的旧版 pip 解析器在 fastapi/pydantic/starlette 交叉约束上会回溯死循环
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# 服务端源码 + 安装脚本（/download/install.* 端点读取 deploy/ 下的脚本）
COPY server/ ./server/
COPY deploy/ ./deploy/

# 前端构建产物（main.py 自动探测 web/dist 并挂为静态站点）
COPY --from=web-builder /build/dist/ ./web/dist/

# 打包插件分发到镜像内置路径 /app/plugin-dist/（download 端点按 data/ → plugin-dist/ 顺序查找）。
# 不放 /app/data：容器里 /app/data 常被外部卷挂载覆盖，放那里镜像内置文件会被藏掉。
COPY plugins/ ./plugins/
RUN mkdir -p plugin-dist \
    && tar -czf plugin-dist/agent-swarm-plugin.tar.gz \
       -C . \
       --exclude='node_modules' --exclude='types' --exclude='*.tsbuildinfo' \
       plugins \
    && rm -rf plugins

# 数据目录（SQLite + 插件包），挂卷持久化
VOLUME ["/app/data"]

ENV AGENT_SWARM_DB=/app/data/agent_swarm.db \
    AGENT_SWARM_PORT=8700 \
    PYTHONUNBUFFERED=1

EXPOSE 8700

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8700/health', timeout=2)"

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8700"]
