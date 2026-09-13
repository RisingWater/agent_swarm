#!/usr/bin/env node
/** agent_swarm claude hooks 时间线桥：把 claude 会话的工具调用/收尾/提问同步到
 * agent_swarm 中枢（nexus timeline），供 web 端实时围观。
 *
 * 注册为 PreToolUse / PostToolUse / Stop 三个事件的 command hook（exec form：
 * node <本文件> <event>），由 claude spawn，stdin 收 hook JSON。
 *
 * 【门控】只有 keepalive 写的 state.json（active 执行状态）存在时才上报——
 * 即 claude 正在处理 swarm call / nexus 指令；用户自己的对话完全不外泄。
 *
 * 事件流向：POST /api/nexus/hook-events（apikey 鉴权）→ 服务端复用
 * nexus._forward_event（落库 + 转发 web 订阅者），事件 kind 与 opencode 插件一致。
 *
 * AskUserQuestion 特殊处理：PreToolUse 上报问题与选项后轮询 answer-<req_id>.json
 * （keepalive 收到 nexus 的 question_reply 后写入），拿到答案以 allow+updatedInput
 * 替用户作答；超时 exit 0 落回本地 TUI 弹窗。
 *
 * 全程零依赖；任何失败都 exit 0 不阻塞 claude。
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SWARM_DIR = join(homedir(), ".claude", "agent-swarm")
const STATE_FILE = join(SWARM_DIR, "state.json")
const ANSWER_POLL_MS = 2_000
const ANSWER_TIMEOUT_MS = 300_000 // 5 分钟：超时落回本地弹窗

const hookEvent = process.argv[2] ?? ""

function readStdin() {
  return new Promise((resolve) => {
    let buf = ""
    process.stdin.setEncoding("utf-8")
    process.stdin.on("data", (c) => (buf += c))
    process.stdin.on("end", () => resolve(buf))
    // stdin 异常时也要退出
    setTimeout(() => resolve(buf), 5_000)
  })
}

async function main() {
  const raw = await readStdin()
  let input = {}
  try { input = JSON.parse(raw) } catch { process.exit(0) }

  // 门控：无活跃 swarm 任务直接放行（不上报、不拦截）
  let state = null
  try { state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) } catch { process.exit(0) }
  if (!state?.active || !state.req_id) process.exit(0)
  const reqId = String(state.req_id)

  // 配置 + 工作区 ID（cwd 即 hook 的项目目录）
  let cfg = {}
  try { cfg = JSON.parse(readFileSync(join(SWARM_DIR, "config.json"), "utf-8")) } catch { process.exit(0) }
  if (!cfg.apiKey || !cfg.serverUrl) process.exit(0)
  const widFile = join(input.cwd ?? process.cwd(), ".agent-swarm.md")
  let wid = ""
  try { wid = readFileSync(widFile, "utf-8").match(/WORKSPACE_ID[:：]\s*([A-Za-z0-9_-]+)/im)?.[1] ?? "" } catch { /* ignore */ }
  if (!wid) process.exit(0)

  const report = async (event) => {
    try {
      await fetch(`${cfg.serverUrl.replace(/\/+$/, "")}/api/nexus/hook-events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: wid, event: { req_id: reqId, ...event } }),
      })
    } catch { /* 失败不阻塞 */ }
  }

  // ---------------- Stop：本轮结束（兜底收尾；正常收尾靠 swarm_reply） ----------------
  if (hookEvent === "Stop") {
    const lastMsg = String(input.last_assistant_message ?? "").trim()
    if (lastMsg) {
      await report({ kind: "text-updated", part_id: `stop-${reqId}`, text: lastMsg, time: Date.now() })
    }
    // 只上报 idle 不清除 state：一次任务可能跨多轮（AskUserQuestion 答复后继续）
    await report({ kind: "session-idle", session_id: String(input.session_id ?? ""), time: Date.now() })
    process.exit(0)
  }

  // ---------------- PreToolUse / PostToolUse：工具事件 ----------------
  const toolName = String(input.tool_name ?? "unknown")

  if (hookEvent === "PreToolUse" && toolName === "AskUserQuestion") {
    // 问题上报 + 轮询远端答案
    const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : []
    await report({
      kind: "question-requested",
      request_id: reqId,
      session_id: String(input.session_id ?? ""),
      question: String(questions[0]?.question ?? questions[0]?.header ?? "请选择"),
      options: (questions[0]?.options ?? []).map((o, i) => ({
        label: String(o.label ?? `选项 ${i + 1}`),
        value: String(o.label ?? ""),
      })),
      time: Date.now(),
    })
    const answerFile = join(SWARM_DIR, `answer-${reqId}.json`)
    const deadline = Date.now() + ANSWER_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, ANSWER_POLL_MS))
      try {
        if (!existsSync(answerFile)) continue
        const { answers } = JSON.parse(readFileSync(answerFile, "utf-8"))
        try { unlinkSync(answerFile) } catch { /* ignore */ }
        // nexus question_reply 的 answers 是 [[value], ...]；AskUserQuestion 要 {question: label}
        const flat = (answers ?? []).flat().filter(Boolean).map(String)
        if (!flat.length) break
        const answersMap = {}
        questions.forEach((q) => { answersMap[String(q.question ?? "")] = flat[0] })
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "answered remotely via agent_swarm nexus",
            updatedInput: { ...input.tool_input, answers: answersMap },
          },
        }))
        process.exit(0)
      } catch { /* 轮询容错 */ }
    }
    // 超时：落回本地 TUI 弹窗
    process.exit(0)
  }

  if (hookEvent === "PreToolUse") {
    await report({
      kind: "tool-state-changed",
      call_id: String(input.tool_use_id ?? ""),
      tool: toolName,
      state: "running",
      input: input.tool_input ?? {},
      time: Date.now(),
    })
    process.exit(0)
  }

  if (hookEvent === "PostToolUse") {
    // 输出截断（时间线不需要完整输出）
    const out = input.tool_response
    let outText = ""
    try {
      outText = typeof out === "string" ? out : JSON.stringify(out)
    } catch { outText = "" }
    if (outText.length > 2000) outText = outText.slice(0, 2000) + "…"
    await report({
      kind: "tool-state-changed",
      call_id: String(input.tool_use_id ?? ""),
      tool: toolName,
      state: "completed",
      output: outText,
      time: Date.now(),
    })
    process.exit(0)
  }

  process.exit(0)
}

main().catch(() => process.exit(0))
