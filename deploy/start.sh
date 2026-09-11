#!/usr/bin/env bash
# agent_swarm 服务启动脚本
# 用法: ./deploy/start.sh [端口]   默认端口 8700
# 环境变量:
#   AGENT_SWARM_DB      SQLite 文件路径 (默认 <项目根>/data/agent_swarm.db)
#   AGENT_SWARM_JWT_SECRET  JWT 签名密钥 (生产环境务必设置)

set -euo pipefail

PORT="${1:-${AGENT_SWARM_PORT:-8700}}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

PYTHON="${PYTHON:-python3}"

# 1. 虚拟环境：不存在则创建，依赖缺失则安装
if [ ! -x ".venv/bin/python" ]; then
    echo "[deploy] creating venv with $PYTHON ..."
    "$PYTHON" -m venv .venv
fi

if ! .venv/bin/python -c "import fastapi, mcp, sqlmodel" 2>/dev/null; then
    echo "[deploy] installing dependencies ..."
    .venv/bin/pip install --upgrade pip -q
    .venv/bin/pip install -r requirements.txt -q
fi

# 2. 端口占用检查：已有实例在跑则提示并退出
if command -v curl >/dev/null 2>&1 && curl -s -m 2 -o /dev/null "http://127.0.0.1:${PORT}/health"; then
    echo "[deploy] agent_swarm already running on :${PORT}"
    exit 0
fi

# 3. 启动（前台运行；Ctrl-C 停止。用 systemd/nohup 托管时按需调整）
echo "[deploy] starting agent_swarm on :${PORT} (db: ${AGENT_SWARM_DB:-data/agent_swarm.db})"
exec .venv/bin/uvicorn server.main:app --host 0.0.0.0 --port "$PORT"
