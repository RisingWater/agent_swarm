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

# 3. 写入本机插件配置（server + apikey）
cat > "$INSTALL_DIR/config.json" <<EOF
{
  "serverUrl": "$SERVER",
  "apiKey": "$API_KEY"
}
EOF
chmod 600 "$INSTALL_DIR/config.json"

# 4. 注册：a) mcp.agent-swarm 配置（工具直连 MCP）b) 插件（心跳保活）
MCP_BLOCK=$(cat <<EOF
    "agent-swarm": {
      "type": "remote",
      "url": "$SERVER/mcp/",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer $API_KEY"
      }
    }
EOF
)
OC_CONFIG="$HOME/.config/opencode/opencode.jsonc"
[ -f "$HOME/.config/opencode/opencode.json" ] && OC_CONFIG="$HOME/.config/opencode/opencode.json"
if [ -f "$PWD/opencode.json" ] || [ -f "$PWD/opencode.jsonc" ]; then
    OC_CONFIG="$PWD/opencode.jsonc"
    [ -f "$PWD/opencode.json" ] && OC_CONFIG="$PWD/opencode.json"
fi

node - "$OC_CONFIG" "$SERVER/mcp/" "$MCP_BLOCK" <<'NODE'
const fs = require("fs")
const [cfgPath, mcpUrl, mcpBlock] = process.argv.slice(2)
let text = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "{\n}\n"
if (text.includes(mcpUrl)) {
    console.log("==> mcp.agent-swarm 已配置，跳过")
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
// 在 mcp 对象中插入 agent-swarm；没有 mcp 字段则插到最外层 { 后
const m = text.match(/("mcp"\s*:\s*\{)([\s\S]*?)(\n  \})/)
let out
if (m) {
    const inner = m[2]
    const stripped = stripJsoncComments(inner).trim()
    const needComma = stripped && !stripped.endsWith(",")
    const newInner = (needComma ? inner.replace(/[ \t\r]+$/, "") + "," : inner) + "\n" + mcpBlock
    out = text.replace(m[0], () => m[1] + newInner + m[3])
} else {
    out = text.replace(/^\s*\{/, () => "{\n  \"mcp\": {\n" + mcpBlock + "\n  },\n")
}
fs.writeFileSync(cfgPath, out)
console.log(`==> 已写入 mcp.agent-swarm 到 ${cfgPath}`)
NODE

# 插件（file:// 指向入口）负责心跳保活
PLUGIN_REF="file://$INSTALL_DIR/src/index.ts"
node - "$OC_CONFIG" "$PLUGIN_REF" <<'NODE'
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
// 在 plugin 数组中插入新项：逗号插在最后一个非空非注释项的末尾
const m = text.match(/("plugin"\s*:\s*\[)([\s\S]*?)(\])/)
let out
if (m) {
    const inner = m[2]
    // 去掉注释与空白后判断是否需要逗号（字符串感知，file:// 不误伤）
    const stripped = stripJsoncComments(inner).trim()
    const needComma = stripped && !stripped.endsWith(",")
    let newInner
    if (needComma) {
        // 找到最后一个非空白/非注释字符（应为 " 或 ]），在其后补逗号
        const tail = inner.replace(/[ \t\n\r]+$/, "")          // 去尾部空白
        newInner = tail + ",\n    \"" + pluginRef + "\"\n  "
    } else {
        newInner = inner + "\n    \"" + pluginRef + "\"\n  "
    }
    out = text.replace(m[0], () => m[1] + newInner + m[3])
} else {
    // 没有 plugin 字段：插到最外层 { 后（保留 ], 后逗号——其后还有其他字段，合法）
    out = text.replace(/^\s*\{/, () => "{\n  \"plugin\": [\n    \"" + pluginRef + "\"\n  ],\n")
}
fs.writeFileSync(cfgPath, out)
console.log(`==> 已注册插件到 ${cfgPath}`)
NODE

# 5. 注册自定义命令（markdown 源文件在 commands/，拷贝即安装）
CMD_DIR="$HOME/.config/opencode/commands"
mkdir -p "$CMD_DIR"

# 旧版命令文件清理（已被 /swarm-* 取代）
for old in swarm-note swarm-desc swarm-resummarize swarm_register swarm; do
    if [ -f "$CMD_DIR/$old.md" ]; then
        rm -f "$CMD_DIR/$old.md"
        echo "    已移除旧命令 /$old"
    fi
done

for f in "$INSTALL_DIR"/commands/swarm-*.md; do
    [ -f "$f" ] || continue
    cp -f "$f" "$CMD_DIR/"
    echo "    已注册命令 /$(basename "$f" .md)"
done

echo "✅ [opencode] 安装完成！重启 opencode 后：MCP 工具可用，插件自动心跳保活。"
