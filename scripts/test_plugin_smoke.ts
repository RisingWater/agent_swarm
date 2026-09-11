/** 插件核心链路冒烟测试：SwarmClient 注册/心跳/列表/求助闭环（Node strip-types 直跑 TS） */
import { SwarmClient } from "../plugin/src/client.ts"

const BASE = "http://localhost:8700"

async function main() {
  // 1. 注册两个测试用户拿 apikey
  const t = Date.now() % 100000
  const reg = async (u) =>
    (await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: "secret1" }),
    })).json()
  const alice = await reg(`pa${t}`)
  const bob = await reg(`pb${t}`)
  const tokenA = alice.token

  // alice 建 team，拉 bob
  const team = await (
    await fetch(`${BASE}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ name: `pt${t}` }),
    })
  ).json()
  await fetch(`${BASE}/api/teams/${team.id}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ username: `pb${t}` }),
  })

  // 2. 模拟两个 opencode 实例的 plugin client
  const ca = new SwarmClient({ serverUrl: BASE, apiKey: alice.api_key })
  const cb = new SwarmClient({ serverUrl: BASE, apiKey: bob.api_key })

  // 3. 注册工作区（模拟 LLM 总结结果）
  const wsa = await ca.registerWorkspace({
    path: `/home/pa${t}/proj`,
    purpose: "LLM 总结：前端项目 React+Vite",
    capabilities: "改组件、修样式",
    teamName: team.name,
  })
  console.log("3. registerWorkspace:", wsa.workspace_id, "created =", wsa.created)
  if (!wsa.workspace_id) throw new Error("register failed")

  const wsb = await cb.registerWorkspace({
    path: `/home/pb${t}/proj`,
    purpose: "LLM 总结：Python 数据管道",
    capabilities: "写 ETL、修数据 bug",
    teamName: team.name,
  })

  // 4. 心跳
  const hb = await ca.heartbeat(wsa.workspace_id, "sess-abc123")
  console.log("4. heartbeat:", JSON.stringify(hb))

  // 5. 列表
  const lst = await ca.listWorkspaces()
  console.log("5. listWorkspaces:", lst.workspaces.map((w) => `${w.name}(${w.owner})`).join(", "))

  // 6. bob 请求 alice 帮助 background
  const hr = await cb.requestHelp({
    requesterWorkspaceId: wsb.workspace_id,
    targetWorkspaceId: wsa.workspace_id,
    question: "Button 组件点击无反应，帮忙看看",
    mode: "background",
  })
  console.log("6. requestHelp:", hr.request_id, hr.status)

  // 7. alice poll
  const tasks = await ca.pollHelpRequests(wsa.workspace_id)
  console.log("7. pollHelpRequests:", tasks.requests.length, "task(s), mode =", tasks.requests[0]?.mode)
  if (tasks.requests[0]?.session_id !== null && tasks.requests[0]?.session_id !== undefined)
    throw new Error("unexpected session_id")

  // 8. 提交结果（模拟 agent 调 swarm_submit_help）
  const sub = await ca.submitHelpResult(hr.request_id, true, "已修复：事件绑定写错了")
  console.log("8. submitHelpResult:", JSON.stringify(sub))

  // 9. bob 查结果
  const res = await cb.getHelpResult(hr.request_id)
  console.log("9. getHelpResult:", res.status, "-", res.result)
  if (res.status !== "done") throw new Error("result not done")

  // 10. notes
  await ca.updateNotes(wsa.workspace_id, "注意事项A")
  await ca.updateNotes(wsa.workspace_id, "注意事项B")
  const lst2 = await ca.listWorkspaces()
  const mine = lst2.workspaces.find((w) => w.workspace_id === wsa.workspace_id)
  console.log("10. notes:", JSON.stringify(mine.notes))
  if (!mine.notes.includes("A") || !mine.notes.includes("B")) throw new Error("notes append failed")

  // 11. updateInfo
  const ui = await ca.updateInfo(wsa.workspace_id, "新用途：Next.js 电商站")
  console.log("11. updateInfo:", ui.purpose)

  console.log("\nPLUGIN CLIENT SMOKE TESTS PASSED")
  process.exit(0)
}

main().catch((e) => {
  console.error("FAILED:", e)
  process.exit(1)
})
