#!/usr/bin/env bash
# agent_swarm deepseek harness 插件安装子脚本（由 deploy/install.sh 分发器调用，参数 --server/--api-key/--src）。
# 对应 install-deepseek.ps1 的 Linux/macOS 版。

set -e

SERVER=""
API_KEY=""
SRC=""
PROFILE=""
PATH_ARG="$(pwd)"
PATH_ARG_EXPLICIT="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2;;
    --api-key) API_KEY="$2"; shift 2;;
    --src) SRC="$2"; shift 2;;
    --profile) PROFILE="$2"; shift 2;;
    --path) PATH_ARG="$2"; PATH_ARG_EXPLICIT="1"; shift 2;;
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

# dsh CLI 探测顺序：PATH → DeepSeek Harness 桌面版内置（Electron asar，未注册 PATH）
DSH_BIN="$(command -v dsh || true)"
DESKTOP_DSH="$HOME/.local/share/DeepSeek Harness/resources/runtime/cli/bin/dsh"
if [ -n "$DSH_BIN" ]; then
  :
elif [ -f "$DESKTOP_DSH" ]; then
  DSH_BIN="$DESKTOP_DSH"
  echo "==> 使用桌面版内置 dsh：$DSH_BIN"
  if [ -z "$PROFILE" ]; then PROFILE="desktop"; fi
else
  echo "错误: 未找到 dsh 命令（PATH 与桌面版默认安装路径均无），请先安装 DeepSeek Harness" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node，请先安装 Node.js 22+" >&2
  exit 1
fi

# 1. bundle 目录 + 转发器
BUNDLE_DIR="$HOME/.dsh/agent-swarm-plugin"
mkdir -p "$BUNDLE_DIR/src"
cp "$SRC/package.json" "$SRC/cordis.patch.yml" "$SRC/register.mjs" "$BUNDLE_DIR/"
cp "$SRC"/src/*.ts "$BUNDLE_DIR/src/"
cat > "$BUNDLE_DIR/index.js" <<'EOF'
// 由 install 脚本生成：转发到 TypeScript 源码（dsh 运行时自带 tsx 加载）
export { apply, name } from "./src/index.ts"
EOF

ADD_ARGS=(plugin)
if [ -n "$PROFILE" ]; then ADD_ARGS+=(--profile "$PROFILE"); fi
ADD_ARGS+=(add "$BUNDLE_DIR")
echo "==> dsh ${ADD_ARGS[*]}（安装 bundle）"
"$DSH_BIN" "${ADD_ARGS[@]}"

# 2. 全局配置 + 环境变量层（bundle 的 mcp-client 条目从 process.env 读凭据）
CFG_DIR="$HOME/.config/dsh"
mkdir -p "$CFG_DIR"
cat > "$CFG_DIR/agent-swarm.json" <<EOF
{"serverUrl": "$SERVER", "apiKey": "$API_KEY"}
EOF
echo "==> 已写配置 $CFG_DIR/agent-swarm.json"

# ~/.dsh/.env：dsh 启动时加载进 process.env
DSH_ENV="$HOME/.dsh/.env"
mkdir -p "$HOME/.dsh"
touch "$DSH_ENV"
# 删旧行再追加（幂等更新）
grep -vE "^AGENT_SWARM_(SERVER|API_KEY)=" "$DSH_ENV" > "$DSH_ENV.tmp" || true
printf 'AGENT_SWARM_SERVER=%s\nAGENT_SWARM_API_KEY=%s\n' "$SERVER" "$API_KEY" >> "$DSH_ENV.tmp"
mv "$DSH_ENV.tmp" "$DSH_ENV"
echo "==> 已更新 $DSH_ENV（AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY）"

# 2.5 skill：复制到 ~/.dsh/skills（dsh 本地提供方 user-dsh root，rank 400）
if [ -d "$SRC/skills" ]; then
  mkdir -p "$HOME/.dsh/skills"
  cp -r "$SRC/skills/." "$HOME/.dsh/skills/"
  echo "==> 已安装 skill 到 $HOME/.dsh/skills/agent-swarm"
fi

# 2.6 MCP 挂载：把解析后的静态条目追加进 profile 用户 patch 层
# （bundle patch 禁止 !!js——plugin-manager 安装期校验不认；这里写明文值）
PROFILE_NAME="${PROFILE:-desktop}"
PROFILE_PATCH="$HOME/.dsh/profiles/$PROFILE_NAME/cordis.patch.yml"
MCP_ENTRY="

# agent-swarm MCP（由 install-deepseek 写入；删掉本段即卸载 mcp__agent-swarm__* 工具）
- id: agent-swarm-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: agent-swarm
    transport: streamable-http
    url: $SERVER/mcp/
    headers:
      Authorization: Bearer $API_KEY
    toolCallTimeoutMs: 120000
    failOnStartupError: false
"
mkdir -p "$(dirname "$PROFILE_PATCH")"
if [ -f "$PROFILE_PATCH" ] && grep -q "agent-swarm-mcp" "$PROFILE_PATCH"; then
  echo "==> MCP 条目已存在于 $PROFILE_PATCH（跳过）"
else
  printf '%s\n' "$MCP_ENTRY" >> "$PROFILE_PATCH"
  echo "==> 已追加 MCP 挂载到 $PROFILE_PATCH"
fi

# 3. 注册工作区（--path 可选：指定项目目录时自动注册；缺省跳过，之后 /swarm-add 即可）
if [ "$PATH_ARG_EXPLICIT" = "1" ]; then
  WS_MD="$PATH_ARG/.agent_swarm/workspace.md"
  if [ -f "$WS_MD" ] && grep -qE "^\s*WORKSPACE_ID[:：]\s*[A-Za-z0-9_-]+" "$WS_MD"; then
    echo "==> 工作区已注册（$WS_MD）"
  else
    echo "==> 注册工作区（$PATH_ARG）..."
    node "$BUNDLE_DIR/register.mjs" --server "$SERVER" --api-key "$API_KEY" --path "$PATH_ARG" --agent-type deepseek \
      || echo "警告: 工作区注册失败（服务端不可达？），可稍后手动注册" >&2
  fi
else
  echo "==> 跳过工作区注册（未指定 --path；之后在 dsh 会话里 /swarm-add 即可）"
fi

echo "✅ [deepseek] 安装完成！重启 dsh（dsh web）后插件自动加载。"
