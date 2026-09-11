#!/usr/bin/env bash
# agent_swarm 服务停止脚本：找到 uvicorn server.main 进程并停止
set -euo pipefail

PORT="${1:-${AGENT_SWARM_PORT:-8700}}"

PIDS=$(pgrep -f "uvicorn server.main:app.*--port ${PORT}" || true)
if [ -z "$PIDS" ]; then
    echo "[deploy] no running agent_swarm on :${PORT}"
    exit 0
fi

echo "[deploy] stopping: $PIDS"
kill $PIDS
sleep 1
# 仍未退出则强杀
PIDS=$(pgrep -f "uvicorn server.main:app.*--port ${PORT}" || true)
[ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null || true
echo "[deploy] stopped"
