#!/usr/bin/env bash
# agent_swarm claude code 插件安装子脚本（由 deploy/install.sh 分发器调用）。
# 做四件事：
#   1. 复制 keepalive.mjs 到安装目录并写配置
#   2. claude mcp add 注册 remote MCP（12 个 workspace_* 工具）
#   3. claude mcp add 注册本地 keepalive MCP（spawn 保活进程）
#   4. 拷贝 /swarm-* 命令到 ~/.claude/commands/
#
# 也支持环境变量 AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY

set -euo pipefail

SERVER="${AGENT_SWARM_SERVER:-}"
API_KEY="${AGENT_SWARM_API_KEY:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.claude/agent-swarm"

while [ $# -gt 0 ]; do
    case "$1" in
        --server)  SERVER="$2"; shift 2 ;;
        --api-key) API_KEY="$2"; shift 2 ;;
        --src)     SRC="$2"; shift 2 ;;
        --dir)     INSTALL_DIR="$2"; shift 2 ;;
        -h|--help)
            echo "用法: install-claude.sh --server <url> --api-key <key> [--src <插件源目录>] [--dir <安装目录>]"
            exit 0 ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
done

if [ -z "$SERVER" ]; then
    echo "错误: 缺少 --server 参数（agent_swarm 服务地址，如 http://10.0.0.1:8700）" >&2
    exit 1
fi
SERVER="${SERVER%/}"
if [ -z "$API_KEY" ]; then
    echo "错误: 缺少 --api-key 参数（在管理页面「API Key」页获取）" >&2
    exit 1
fi

echo "==> [claude] 安装插件"
echo "    服务器: $SERVER"
echo "    目录:   $INSTALL_DIR"

command -v claude >/dev/null || { echo "错误: 未找到 claude 命令，请先安装 Claude Code" >&2; exit 1; }
command -v node >/dev/null || { echo "错误: 未找到 node（keepalive 需要），请先安装 Node.js" >&2; exit 1; }

# 1. 复制插件文件到安装目录 + 写配置（keepalive.mjs 读取）
mkdir -p "$INSTALL_DIR"
[ -f "$SRC/keepalive.mjs" ] && cp -f "$SRC/keepalive.mjs" "$INSTALL_DIR/"
[ -f "$SRC/hook-timeline.mjs" ] && cp -f "$SRC/hook-timeline.mjs" "$INSTALL_DIR/"
[ -f "$SRC/merge-hooks.mjs" ] && cp -f "$SRC/merge-hooks.mjs" "$INSTALL_DIR/"
cat > "$INSTALL_DIR/config.json" <<EOF
{
  "serverUrl": "$SERVER",
  "apiKey": "$API_KEY"
}
EOF
chmod 600 "$INSTALL_DIR/config.json"

# 2. 注册 remote MCP（工具直连；幂等：已存在则跳过）
MCP_LIST="$(claude mcp list 2>/dev/null || true)"
if echo "$MCP_LIST" | grep -Eq '^[[:space:]]*agent-swarm[[:space:]]*:'; then
    echo "==> mcp agent-swarm 已注册，跳过"
else
    claude mcp add --scope user --transport http agent-swarm "$SERVER/mcp/" --header "Authorization: Bearer $API_KEY"
    echo "==> 已注册 remote MCP agent-swarm"
fi

# 3. 注册本地 keepalive MCP（spawn 保活进程；幂等）
KEEPALIVE="$INSTALL_DIR/keepalive.mjs"
if [ ! -f "$KEEPALIVE" ]; then
    echo "警告: keepalive.mjs 不在分发包中，跳过保活注册（仅命令可用）" >&2
elif echo "$MCP_LIST" | grep -Eq '^[[:space:]]*agent-swarm-keepalive[[:space:]]*:'; then
    # 已注册也要确保命令路径指向最新安装目录
    claude mcp remove --scope user agent-swarm-keepalive >/dev/null 2>&1 || true
    claude mcp add --scope user agent-swarm-keepalive -- node "$KEEPALIVE"
    echo "==> 已更新本地 MCP agent-swarm-keepalive"
else
    claude mcp add --scope user agent-swarm-keepalive -- node "$KEEPALIVE"
    echo "==> 已注册本地 MCP agent-swarm-keepalive（保活）"
fi

# 4. 注册 hooks（PreToolUse/PostToolUse/Stop → hook-timeline.mjs），幂等合并进 settings.json
# 合并逻辑在 merge-hooks.mjs（与 ps1 共用；保留用户 env/theme 等已有字段）
HOOK_SCRIPT="$INSTALL_DIR/hook-timeline.mjs"
MERGE_SCRIPT="$INSTALL_DIR/merge-hooks.mjs"
if [ -f "$HOOK_SCRIPT" ] && [ -f "$MERGE_SCRIPT" ]; then
    node "$MERGE_SCRIPT" "$HOME/.claude/settings.json" "$HOOK_SCRIPT"
    echo "提示: 任务注入需以 --dangerously-load-development-channels server:agent-swarm-keepalive 启动 claude"
else
    echo "警告: hook-timeline.mjs/merge-hooks.mjs 不在分发包中，跳过 hooks 注册（时间线不可用）" >&2
fi

# 5. 注册自定义命令（markdown 源文件在 commands/，拷贝即安装）
CMD_DIR="$HOME/.claude/commands"
mkdir -p "$CMD_DIR"
for f in "$SRC"/commands/swarm-*.md; do
    [ -f "$f" ] || continue
    cp -f "$f" "$CMD_DIR/"
    echo "    已注册命令 /$(basename "$f" .md)"
done

echo "✅ [claude] 安装完成！重启 claude 后：MCP 工具可用，keepalive 自动心跳保活。"
