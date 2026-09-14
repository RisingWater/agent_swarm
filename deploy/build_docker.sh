#!/usr/bin/env bash
# 构建 agent_swarm Docker 镜像（纯 docker build，不用 compose）
# 用法: ./deploy/build_docker.sh [镜像tag]   默认 tag: agent-swarm:latest

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

TAG="${1:-agent-swarm:latest}"

command -v docker >/dev/null || { echo "错误: 未安装 docker" >&2; exit 1; }

echo "[docker] building $TAG ..."
docker build -t "$TAG" -f docker/Dockerfile .

echo
echo "[docker] done: $TAG"
echo "运行:"
echo "  docker run -d --name agent-swarm \\"
echo "    -p 8700:8700 \\"
echo "    -v agent-swarm-data:/app/data \\"
echo "    -e AGENT_SWARM_JWT_SECRET=<随机长字符串> \\"
echo "    $TAG"
