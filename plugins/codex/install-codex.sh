#!/usr/bin/env bash
set -euo pipefail
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server=""
key=""
uninstall=false
while (( $# )); do
    case "$1" in
        --server) server="$2"; shift 2 ;;
        --api-key) key="$2"; shift 2 ;;
        --src) src="$2"; shift 2 ;;
        --uninstall) uninstall=true; shift ;;
        *) exit 2 ;;
    esac
done
command -v codex >/dev/null || { echo "Codex CLI not found; skipping."; exit 0; }
if "$uninstall"; then
    exec node "$src/install.mjs" --uninstall
fi
AGENT_SWARM_CODEX_SERVER="$server" AGENT_SWARM_CODEX_KEY="$key" exec node "$src/install.mjs"
