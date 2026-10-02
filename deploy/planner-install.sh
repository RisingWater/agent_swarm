#!/usr/bin/env bash
# agent_swarm 规划核心服务（planner）一键安装脚本（平台分发，免鉴权）
# 用法：curl -fsSL <平台地址>/download/planner-install.sh | bash -s -- --api-key as_xxx
# 作用：把 agent_swarm_planner 克隆到 ~/.agent_swarm/agent_swarm_planner（已存在则更新到最新），
#       再运行其 deploy/install.sh 完成安装（建 venv / 装依赖 / 写配置 / 注册开机自启）。
# 装完后在项目目录的 harness 里执行 /swarm-add-planner 完成注册。
set -euo pipefail

SERVER="__SERVER_URL__"
API_KEY=""
REPO="${AGENT_SWARM_PLANNER_REPO:-https://github.com/RisingWater/agent_swarm_planner.git}"
DEST="${AGENT_SWARM_PLANNER_DIR:-$HOME/.agent_swarm/agent_swarm_planner}"
BRANCH="${AGENT_SWARM_PLANNER_BRANCH:-master}"

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2;;
    --api-key) API_KEY="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --dir) DEST="$2"; shift 2;;
    -h|--help) sed -n '2,8p' "$0"; exit 0;;
    *) echo "未知参数: $1" >&2; exit 2;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "需要 git，请先安装" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "需要 Python 3.11+（python3），请先安装" >&2; exit 1; }

if [ -d "$DEST/.git" ]; then
  echo "==> 更新已有仓库 $DEST"
  git -C "$DEST" fetch --depth 1 origin "$BRANCH"
  git -C "$DEST" checkout -q "$BRANCH"
  git -C "$DEST" reset --hard "origin/$BRANCH"
else
  echo "==> 克隆 $REPO -> $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DEST"
fi

cd "$DEST"
ARGS=(--server "$SERVER")
if [ -n "$API_KEY" ]; then ARGS+=(--api-key "$API_KEY"); fi
echo "==> 运行安装：./deploy/install.sh ${ARGS[*]}"
exec ./deploy/install.sh "${ARGS[@]}"
