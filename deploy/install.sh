#!/usr/bin/env bash
# agent_swarm 插件分发安装器：下载分发包（含所有 agent 插件），逐个执行各插件的
# install-*.sh 安装子脚本。一条命令装好所有 agent。
# 典型用法（在管理页面复制完整命令）:
#   curl -fsSL http://<server>/download/install.sh | bash -s -- --server http://<server> --api-key as_xxx
#
# 可选: --only opencode,claude  只装指定插件（缺省全装）
# 环境变量: AGENT_SWARM_SERVER / AGENT_SWARM_API_KEY

set -euo pipefail

SERVER="${AGENT_SWARM_SERVER:-__SERVER_URL__}"
API_KEY="${AGENT_SWARM_API_KEY:-}"
ONLY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --server)  SERVER="$2"; shift 2 ;;
        --api-key) API_KEY="$2"; shift 2 ;;
        --only)    ONLY="$2"; shift 2 ;;
        -h|--help)
            echo "用法: install.sh [--api-key <key>] [--server <url>] [--only opencode,claude]"
            echo "  server 地址默认已内置（由服务端注入），apikey 可用环境变量 AGENT_SWARM_API_KEY"
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

echo "==> agent_swarm 插件安装"
echo "    服务器: $SERVER"

# 0. 前置检查
command -v curl >/dev/null || { echo "错误: 需要 curl" >&2; exit 1; }
command -v tar >/dev/null || { echo "错误: 需要 tar" >&2; exit 1; }

# 1. 下载并解压分发包（内含 plugins/ 下各 agent 插件目录 + 安装子脚本）
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "==> 下载插件包..."
curl -fsSL "$SERVER/download/plugin.tar.gz" -o "$TMP/plugins.tar.gz"
mkdir -p "$TMP/dist"
tar -xzf "$TMP/plugins.tar.gz" -C "$TMP/dist"
if [ ! -d "$TMP/dist/plugins" ]; then
    # 兼容旧包（plugin/ 单插件布局）
    mkdir -p "$TMP/dist/plugins/opencode"
    mv "$TMP/dist/plugin" "$TMP/dist/plugins/opencode"
fi

# 2. 遍历 plugins/ 下每个插件目录，执行其 install-*.sh
WANT=""
if [ -n "$ONLY" ]; then
    WANT=$(echo "$ONLY" | tr ',' ' ')
fi
FAILED=0
for dir in "$TMP/dist/plugins"/*/; do
    name=$(basename "$dir")
    # --only 过滤（可选）
    if [ -n "$WANT" ]; then
        skip=true
        for w in $WANT; do [ "$w" = "$name" ] && skip=false; done
        if $skip; then
            echo "==> 跳过 $name（--only 未包含）"
            continue
        fi
    fi
    script=""
    for f in "$dir/install-$name.sh" "$dir/install.sh"; do
        [ -f "$f" ] && script="$f" && break
    done
    if [ -z "$script" ]; then
        echo "==> 跳过 $name（无安装脚本）"
        continue
    fi
    echo
    echo "======== 安装 $name ========"
    if ! bash "$script" --server "$SERVER" --api-key "$API_KEY" --src "$dir"; then
        echo "⚠️  $name 安装失败（继续安装其余插件）" >&2
        FAILED=1
    fi
done

echo
if [ "$FAILED" = "0" ]; then
    echo "✅ 全部插件安装完成！"
else
    echo "✅ 安装完成（部分插件失败，见上方日志）"
fi
