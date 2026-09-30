#!/usr/bin/env bash
# agent_swarm deepseek harness 插件安装子脚本（由 deploy/install.sh 分发器调用，参数 --server/--api-key/--src）。
# 对应 install-deepseek.ps1 的 Linux/macOS 版。

set -e

SERVER=""
API_KEY=""
SRC=""
PROFILE=""
PATH_ARG="$(pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2;;
    --api-key) API_KEY="$2"; shift 2;;
    --src) SRC="$2"; shift 2;;
    --profile) PROFILE="$2"; shift 2;;
    --path) PATH_ARG="$2"; shift 2;;
    *) shift;;
  esac
done

if [ -z "$SERVER" ]; then SERVER="${AGENT_SWARM_SERVER:-}"; fi
if [ -z "$API_KEY" ]; then API_KEY="${AGENT_SWARM_API_KEY:-}"; fi
SERVER="${SERVER%/}"

if [ -z "$SERVER" ] || [[ "$SERVER" != *"://"* ]]; then
  echo "错误: 缺少 --server 参数（agent_swarm 服务地址，如 http://10.0.0.1:8700）" >&2
  exit 1
fi
if [ -z "$API_KEY" ]; then
  echo "错误: 缺少 --api-key 参数（在管理页面「API Key」页获取）" >&2
  exit 1
fi

echo "==> [deepseek] 安装插件"
echo "    服务器: $SERVER"

if ! command -v dsh >/dev/null 2>&1; then
  echo "错误: 未找到 dsh 命令，请先安装 DeepSeek Harness" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node，请先安装 Node.js 22+" >&2
  exit 1
fi

# 1. bundle 目录 + 转发器
BUNDLE_DIR="$HOME/.dsh/agent-swarm-plugin"
mkdir -p "$BUNDLE_DIR/src"
cp "$SRC/package.json" "$SRC/cordis.patch.yml" "$BUNDLE_DIR/"
cp "$SRC"/src/*.ts "$BUNDLE_DIR/src/"
cat > "$BUNDLE_DIR/index.js" <<'EOF'
// 由 install 脚本生成：转发到 TypeScript 源码（dsh 运行时自带 tsx 加载）
export { apply, name } from "./src/index.ts"
EOF

ADD_ARGS=(plugin)
if [ -n "$PROFILE" ]; then ADD_ARGS+=(--profile "$PROFILE"); fi
ADD_ARGS+=(add "$BUNDLE_DIR")
echo "==> dsh ${ADD_ARGS[*]}（安装 bundle）"
dsh "${ADD_ARGS[@]}"

# 2. 全局配置
CFG_DIR="$HOME/.config/dsh"
mkdir -p "$CFG_DIR"
cat > "$CFG_DIR/agent-swarm.json" <<EOF
{"serverUrl": "$SERVER", "apiKey": "$API_KEY"}
EOF
echo "==> 已写配置 $CFG_DIR/agent-swarm.json"

# 3. 注册工作区
WS_MD="$PATH_ARG/.agent_swarm/workspace.md"
if [ -f "$WS_MD" ] && grep -qE "^\s*WORKSPACE_ID[:：]\s*[A-Za-z0-9_-]+" "$WS_MD"; then
  echo "==> 工作区已注册（$WS_MD）"
else
  echo "==> 注册工作区（$PATH_ARG）..."
  node "$BUNDLE_DIR/register.mjs" --server "$SERVER" --api-key "$API_KEY" --path "$PATH_ARG" --agent-type deepseek \
    || echo "警告: 工作区注册失败（服务端不可达？），可稍后手动注册" >&2
fi

echo "✅ [deepseek] 安装完成！重启 dsh（dsh web）后插件自动加载。"
