#!/usr/bin/env bash
# agent_swarm opencode 插件安装子脚本（由 deploy/install.sh 分发器调用）。
# 分发器已把插件包解压到 $SRC（即本脚本所在目录），本脚本只做本地注册：
#   1. 链接/安装依赖            2. 写入 config.json
#   3. 注册 mcp.agent-swarm     4. 注册插件（心跳保活）
#   5. 安装 /swarm-* 命令
#
# 也支持环境变量: AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY

set -euo pipefail

SERVER="${AGENT_SWARM_SERVER:-}"
API_KEY="${AGENT_SWARM_API_KEY:-}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.config/opencode/plugins/agent-swarm"

while [ $# -gt 0 ]; do
    case "$1" in
        --server)  SERVER="$2"; shift 2 ;;
        --api-key) API_KEY="$2"; shift 2 ;;
        --dir)     INSTALL_DIR="$2"; shift 2 ;;
        --src)     SRC="$2"; shift 2 ;;
        -h|--help)
            echo "用法: install-opencode.sh --server <url> --api-key <key> [--src <插件源目录>] [--dir <安装目录>]"
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
if [ ! -f "$SRC/package.json" ]; then
    echo "错误: 插件源目录无效（缺 package.json）: $SRC" >&2
    exit 1
fi

echo "==> [opencode] 安装插件"
echo "    服务器: $SERVER"
echo "    目录:   $INSTALL_DIR"

command -v node >/dev/null || { echo "错误: 需要 node（opencode 依赖），请先安装 Node.js" >&2; exit 1; }

# 1. 复制插件文件到安装目录（源目录来自分发包，保持其只读）
mkdir -p "$INSTALL_DIR"
cp -R "$SRC/." "$INSTALL_DIR/"

# 2. 安装依赖（复用 opencode 全局已有的 @opencode-ai/*，避免重复下载）
echo "==> 安装依赖..."
NPM=""
for c in npm; do command -v $c >/dev/null && NPM=$c && break; done
[ -z "$NPM" ] && { echo "错误: 需要 npm" >&2; exit 1; }

# 链接 opencode 自带的 node_modules（含 @opencode-ai/plugin、sdk、zod），有则省安装
OC_GLOBAL_NM=""
for candidate in \
    "$(dirname "$(readlink -f "$(command -v opencode)" 2>/dev/null || echo "")")/../lib/node_modules/opencode-ai/node_modules" \
    "$HOME/.config/opencode/node_modules"; do
    if [ -d "$candidate/@opencode-ai" ]; then OC_GLOBAL_NM="$candidate"; break; fi
done

if [ -n "$OC_GLOBAL_NM" ]; then
    echo "    复用 opencode 依赖: $OC_GLOBAL_NM"
    ln -sfn "$OC_GLOBAL_NM" "$INSTALL_DIR/node_modules" 2>/dev/null || true
fi

if [ ! -d "$INSTALL_DIR/node_modules/@opencode-ai" ]; then
    (cd "$INSTALL_DIR" && "$NPM" install --no-audit --no-fund --loglevel=error)
fi

# 3. 写入本机插件配置（server + apikey + 执行模式）
#    两处都写：loadConfig() 读 ~/.config/opencode/agent-swarm.json（全局），
#    INSTALL_DIR/config.json 保留作向后兼容/排查用。
#    executionMode 已有人工设置时不覆盖（幂等重装保留用户选择）
write_cfg() {
    local dest="$1"
    if [ -f "$dest" ] && grep -q '"executionMode"' "$dest" 2>/dev/null; then
        # 保留现有 executionMode，仅更新 server/apiKey
        node - "$dest" "$SERVER" "$API_KEY" <<'NODE'
const fs = require("fs")
const [p, server, key] = process.argv.slice(2)
const cfg = JSON.parse(fs.readFileSync(p, "utf-8"))
cfg.serverUrl = server
cfg.apiKey = key
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n")
NODE
    else
        printf '{\n  "serverUrl": "%s",\n  "apiKey": "%s",\n  "executionMode": "foreground",\n  "backgroundCommand": "auto"\n}\n' "$SERVER" "$API_KEY" > "$dest"
    fi
}
write_cfg "$INSTALL_DIR/config.json"
chmod 600 "$INSTALL_DIR/config.json"
GLOBAL_CFG="$HOME/.config/opencode/agent-swarm.json"
write_cfg "$GLOBAL_CFG"
chmod 600 "$GLOBAL_CFG"
echo "    已写入插件配置: $GLOBAL_CFG"

# 4. 注册：a) mcp.agent-swarm 配置（工具直连 MCP）b) 插件（心跳保活）
OC_CONFIG="$HOME/.config/opencode/opencode.jsonc"
[ -f "$HOME/.config/opencode/opencode.json" ] && OC_CONFIG="$HOME/.config/opencode/opencode.json"
if [ -f "$PWD/opencode.json" ] || [ -f "$PWD/opencode.jsonc" ]; then
    OC_CONFIG="$PWD/opencode.jsonc"
    [ -f "$PWD/opencode.json" ] && OC_CONFIG="$PWD/opencode.json"
fi
node - "$OC_CONFIG" "$SERVER/mcp/" "$API_KEY" <<'NODE'
const fs = require("fs")
const [cfgPath, mcpUrl, apiKey] = process.argv.slice(2)
let text = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "{\n}\n"
// 剥 JSONC 注释（感知字符串字面量：file:// 等字符串内的 // 不能当注释）
function stripJsoncComments(s) {
    let out = ""
    let inStr = false, inLine = false, inBlock = false
    for (let i = 0; i < s.length; i++) {
        const c = s[i], n = s[i + 1]
        if (inLine) { if (c === "\n") { inLine = false; out += c } continue }
        if (inBlock) { if (c === "*" && n === "/") { inBlock = false; out += " "; i++ } continue }
        if (inStr) {
            out += c
            if (c === "\\") { out += n ?? ""; i++ }
            else if (c === '"') inStr = false
            continue
        }
        if (c === '"') { inStr = true; out += c; continue }
        if (c === "/" && n === "/") { inLine = true; i++; continue }
        if (c === "/" && n === "*") { inBlock = true; i++ }
        out += c
    }
    return out
}
// 读改写走 JSON 往返（parse → 对象操作 → stringify），杜绝文本手术写出坏 JSON
// （曾用正则插入，第二次运行替换分支把嵌套 headers 的 } 误当对象结尾，配置文件被写坏）
const mcpEntry = {
    type: "remote",
    url: mcpUrl,
    enabled: true,
    headers: { Authorization: `Bearer ${apiKey}` },
}
const stripped = stripJsoncComments(text)
let cfg
try {
    cfg = JSON.parse(stripped || "{}")
} catch (e) {
    console.error(`错误: ${cfgPath} 不是合法 JSON(C)（${e.message}），不覆盖，请手工修正后重跑`)
    process.exit(1)
}
cfg.mcp = cfg.mcp || {}
cfg.mcp["agent-swarm"] = mcpEntry
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")
console.log(`==> 已写入 mcp.agent-swarm 到 ${cfgPath}`)
NODE

# 插件注册（file:// 指向入口）：src/index.ts = server 插件（心跳/任务执行）
register_plugin() {
node - "$1" "$2" <<'NODE'
const fs = require("fs")
const [cfgPath, pluginRef] = process.argv.slice(2)
let text = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "{}\n"
if (text.includes(pluginRef)) {
    console.log("==> 插件已在配置中，跳过注册")
    process.exit(0)
}
// 剥 JSONC 注释（感知字符串字面量：file:// 等字符串内的 // 不能当注释）
function stripJsoncComments(s) {
    let out = ""
    let inStr = false, inLine = false, inBlock = false
    for (let i = 0; i < s.length; i++) {
        const c = s[i], n = s[i + 1]
        if (inLine) { if (c === "\n") { inLine = false; out += c } continue }
        if (inBlock) { if (c === "*" && n === "/") { inBlock = false; out += " "; i++ } continue }
        if (inStr) {
            out += c
            if (c === "\\") { out += n ?? ""; i++ }
            else if (c === '"') inStr = false
            continue
        }
        if (c === '"') { inStr = true; out += c; continue }
        if (c === "/" && n === "/") { inLine = true; i++; continue }
        if (c === "/" && n === "*") { inBlock = true; i++; continue }
        out += c
    }
    return out
}
// JSON 往返读改写（同 mcp 注册：杜绝文本手术产出坏 JSON）
let cfg
try {
    cfg = JSON.parse(stripJsoncComments(text) || "{}")
} catch (e) {
    console.error(`警告: ${cfgPath} 不是合法 JSON(C)（${e.message}），跳过插件注册`)
    process.exit(0)
}
if (!Array.isArray(cfg.plugin)) cfg.plugin = cfg.plugin ? [cfg.plugin] : []
if (!cfg.plugin.includes(pluginRef)) cfg.plugin.push(pluginRef)
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")
console.log(`==> 已注册插件 ${pluginRef}`)
NODE
}
register_plugin "$OC_CONFIG" "file://$INSTALL_DIR/src/index.ts"

# TUI 插件注册到 ~/.config/opencode/tui.jsonc（v1 TUI 插件与 server 插件分开注册）
TUI_CFG="$HOME/.config/opencode/tui.jsonc"
TUI_REF="file://$INSTALL_DIR/src/tui.ts"
if [ ! -f "$TUI_CFG" ]; then
    mkdir -p "$(dirname "$TUI_CFG")"
    cat > "$TUI_CFG" <<EOF
{
  "\$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "${TUI_REF}"
  ]
}
EOF
    echo "==> 已创建并注册 TUI 插件到 ${TUI_CFG}"
else
    register_plugin "$TUI_CFG" "$TUI_REF"
fi

# 5. 安装 md 命令（/swarm-add：前台会话由 agent 生成 purpose 后调 MCP 工具）
CMD_DIR="$HOME/.config/opencode/commands"
mkdir -p "$CMD_DIR"
cp "$SRC/commands/swarm-add.md" "$CMD_DIR/swarm-add.md"
echo "==> 已安装 /swarm-add 命令"

# 6. 清理已废弃的 md 命令（/swarm-* 其余为 TUI 原生命令，见 src/tui.ts；swarm-register 已废弃）
for old in swarm-note swarm-desc swarm-resummarize swarm_register swarm-remove \
           swarm-enable swarm-disable swarm-register swarm-mode; do
    if [ -f "$CMD_DIR/$old.md" ]; then
        rm -f "$CMD_DIR/$old.md"
        echo "    已移除旧命令 /$old"
    fi
done

echo "✅ [opencode] 安装完成！重启 opencode 后：MCP 工具可用，插件自动心跳保活，/swarm-* 命令就绪。"
