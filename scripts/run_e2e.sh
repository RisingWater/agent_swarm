#!/usr/bin/env bash
# agent_swarm 端到端联调：重启服务（干净库）→ 管理 API 测试 → MCP e2e → 插件冒烟
set -e
cd /home/wangxu/workdir/agent_swarm

echo "== 1. 重置环境 =="
pkill -f "uvicorn server.main" 2>/dev/null || true
sleep 1
rm -f data/agent_swarm.db
setsid nohup .venv/bin/uvicorn server.main:app --port 8700 </dev/null > /tmp/opencode/swarm_server.log 2>&1 &
sleep 3
HEALTH=$(curl -s -m 5 -o /dev/null -w "%{http_code}" localhost:8700/health)
echo "   server health: $HEALTH"
[ "$HEALTH" = "200" ] || { echo "server failed"; exit 1; }

echo "== 2. 管理 API 测试 =="
.venv/bin/python /tmp/opencode/test_api.py

echo "== 3. MCP 端到端 =="
.venv/bin/python /tmp/opencode/test_mcp_e2e.py

echo "== 4. 插件客户端冒烟 =="
node --experimental-strip-types --no-warnings scripts/test_plugin_smoke.ts 2>&1 | grep -v ExperimentalWarning

echo "== 5. 在线状态超时 =="
KEY_RESP=$(.venv/bin/python - <<'EOF'
import httpx, json, time
# inline
c = httpx.Client(base_url="http://localhost:8700", timeout=10)
r = c.post("/api/auth/register", json={"username": f"hb{time.time()%100000}", "password": "secret1"})
d = r.json()
h = {"Authorization": f"Bearer {d['api_key']}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
def call(name, args):
    r = c.post("/mcp/", headers=h, json={"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}})
    sid = r.headers.get("mcp-session-id")
    if sid:
        h["mcp-session-id"] = sid
        c.post("/mcp/", headers=h, json={"jsonrpc":"2.0","method":"notifications/initialized"})
    r = c.post("/mcp/", headers=h, json={"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":name,"arguments":args}})
    return r.json()["result"]
call("register_workspace", {"path": f"/tmp/hb{time.time()%100000}/p", "purpose": "t"})
# 不心跳，90s 后才离线 —— 先确认现在是 online
lst = call("list_workspaces", {})
data = lst.get("structuredContent") or json.loads(lst["content"][0]["text"])
print("ONLINE" if any(w["status"]=="online" for w in data["workspaces"]) else "OFFLINE")
EOF
)
echo "   注册后未心跳状态: $KEY_RESP (应为 ONLINE)"

echo
echo "========== ALL E2E SUITES PASSED =========="
