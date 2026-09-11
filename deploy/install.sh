#!/usr/bin/env bash
# agent_swarm opencode 插件安装脚本
# 典型用法（在管理页面复制完整命令）:
#   curl -fsSL http://<server>/download/install.sh | bash -s -- --server http://<server> --api-key as_xxx
#
# 也支持环境变量: AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY

set -euo pipefail

SERVER="${AGENT_SWARM_SERVER:-__SERVER_URL__}"
API_KEY="${AGENT_SWARM_API_KEY:-}"
INSTALL_DIR="${HOME}/.config/opencode/plugins/agent-swarm"
GLOBAL=false

while [ $# -gt 0 ]; do
    case "$1" in
        --server)   SERVER="$2"; shift 2 ;;
        --api-key)  API_KEY="$2"; shift 2 ;;
        --dir)      INSTALL_DIR="$2"; shift 2 ;;
        -g|--global) GLOBAL=true; shift ;;
        -h|--help)
            echo "用法: install.sh [--api-key <key>] [--server <url>] [--dir <安装目录>] [-g]"
            echo "  server 地址默认已内置（由服务端注入），apikey 可用环境变量 AGENT_SWARM_API_KEY"
            exit 0 ;;
        *) echo "未知参数: $1" >&2; exit 1 ;;
    esac
done

if [ -z "$SERVER" ]; then
    # 尝试从脚本下载来源推断（curl 传入的 Referer 不可靠，直接报错）
    echo "错误: 缺少 --server 参数（agent_swarm 服务地址，如 http://10.0.0.1:8700）" >&2
    exit 1
fi
SERVER="${SERVER%/}"
if [ -z "$API_KEY" ]; then
    echo "错误: 缺少 --api-key 参数（在管理页面「API Key」页获取）" >&2
    exit 1
fi

echo "==> agent_swarm 插件安装"
echo "    服务器: $SERVER"
echo "    目录:   $INSTALL_DIR"

# 0. 前置检查
command -v curl >/dev/null || { echo "错误: 需要 curl" >&2; exit 1; }
if ! command -v node >/dev/null; then
    echo "错误: 需要 node（opencode 依赖），请先安装 Node.js" >&2
    exit 1
fi

# 1. 下载并解压插件包
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "==> 下载插件包..."
curl -fsSL "$SERVER/download/plugin.tar.gz" -o "$TMP/plugin.tar.gz"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP/plugin.tar.gz" -C "$INSTALL_DIR"

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

# 4. 注册到 opencode 配置（file:// 指向入口；全局 = ~/.config/opencode/opencode.jsonc）
PLUGIN_REF="file://$INSTALL_DIR/src/index.ts"
if [ "$GLOBAL" = true ] || [ ! -f "$PWD/opencode.json" ] && [ ! -f "$PWD/opencode.jsonc" ]; then
    OC_CONFIG="$HOME/.config/opencode/opencode.jsonc"
    [ -f "$HOME/.config/opencode/opencode.json" ] && OC_CONFIG="$HOME/.config/opencode/opencode.json"
else
    OC_CONFIG="$PWD/opencode.jsonc"
    [ -f "$PWD/opencode.json" ] && OC_CONFIG="$PWD/opencode.json"
fi

node - "$OC_CONFIG" "$PLUGIN_REF" <<'NODE'
const fs = require("fs")
const [cfgPath, pluginRef] = process.argv.slice(2)
let text = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf-8") : "{}\n"
if (text.includes(pluginRef)) {
    console.log("==> 插件已在配置中，跳过注册")
    process.exit(0)
}
// 在 plugin 数组中插入新项：逗号插在最后一个非空非注释项的末尾
const m = text.match(/("plugin"\s*:\s*\[)([\s\S]*?)(\])/)
let out
if (m) {
    const inner = m[2]
    // 去掉注释与空白后判断是否需要逗号
    const stripped = inner.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim()
    const needComma = stripped && !stripped.endsWith(",")
    let newInner
    if (needComma) {
        // 找到最后一个非空白/非注释字符（应为 " 或 ]），在其后补逗号
        const tail = inner.replace(/[ \t\n\r]+$/, "")          // 去尾部空白
        newInner = tail + ",\n    \"" + pluginRef + "\"\n  "
    } else {
        newInner = inner + "\n    \"" + pluginRef + "\"\n  "
    }
    out = text.replace(m[0], m[1] + newInner + m[3])
} else {
    // 没有 plugin 字段：插到最外层 { 后（保留 ], 后逗号——其后还有其他字段，合法）
    out = text.replace(/^\s*\{/, "{\n  \"plugin\": [\n    \"" + pluginRef + "\"\n  ],\n")
}
fs.writeFileSync(cfgPath, out)
console.log(`==> 已注册插件到 ${cfgPath}`)
NODE

echo
echo "✅ 安装完成！"
echo "   重启 opencode 后插件自动注册工作区。"
echo "   自定义命令: /swarm-note <备注>  /swarm-desc <描述>  /swarm-resummarize"
