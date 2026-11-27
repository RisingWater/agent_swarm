import { AppServer, launchCodex } from "./app-server.mjs"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { openForeground, prepareForegroundThread } from "./foreground.mjs"
import { agentMessage, artifactUpdate, statusUpdate, streamStatus, toolStatus } from "../claude/nexus_a2a.mjs"

const LIMIT = 24_000

function toolName(item) {
  switch (item.type) {
    case "commandExecution": return "bash"
    case "fileChange": return "fileChange"
    case "mcpToolCall": return `${item.server}/${item.tool}`
    case "dynamicToolCall": return item.tool
    default: return null
  }
}

// 两种执行方式共用事件归一化。前台只关联带有本次提交 ID 的用户消息。
export async function executeTask(job, cwd, emit, signal, launch = launchCodex, {
  threadTarget, connect, hasSwarmMcp = false,
} = {}) {
  const foreground = Boolean(threadTarget)
  const mode = foreground ? "前台" : "后台"
  const metadata = { background: !foreground, agent: "codex", message_id: job.messageId }
  let app, readHistory
  try {
    if (foreground) ({ app, readHistory } = await openForeground(cwd, launch, connect))
    else {
      // Codex 启动 MCP 时过滤父环境，需要显式配置 MCP 的 env。
      const args = ["app-server", "--listen", "stdio://"]
      if (hasSwarmMcp) args.push("-c", 'mcp_servers.agent-swarm.env.AGENT_SWARM_CODEX_NO_WORKER="1"')
      app = new AppServer(launch(args, { cwd }))
    }
  } catch (error) {
    emit(statusUpdate(job, "failed", { final: true, metadata, message: agentMessage(error.message, job) }))
    return "failed"
  }
  const messages = new Map()
  const commandOutputs = new Map()
  const completedItems = new Set()
  const clientId = foreground ? randomUUID() : job.messageId
  let threadId, turnId, turnStart, queued, submissionId, cancellation, stop
  let settled = false
  const result = new Promise(resolve => {
    stop = outcome => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
  })
  const fail = reason => stop({ state: "failed", reason })
  const stopTask = outcome => {
    if (settled) return
    stop(outcome)
    cancellation = (async () => {
      if (queued) await queued.catch(() => {})
      if (!turnId && submissionId) {
        try {
          await app.call("thread/queue/delete", { threadId, queuedSubmissionId: submissionId }, 1500)
          return
        } catch { /* 消息可能已经出队，只尝试中断已确认归属的 turn */ }
      }
      if (!readHistory && threadId && turnId) await app.call("turn/interrupt", { threadId, turnId }, 1500).catch(() => {})
    })()
  }
  const cancel = () => stopTask({ state: "canceled" })
  app.on("closed", () => fail("Codex App Server 连接中断"))
  // 后台没有原生审批界面。收到服务端请求就停止该任务，不代答或改变权限配置。
  if (!foreground) app.on("request", () => fail("Codex 后台任务需要人工交互，任务已停止"))
  signal.addEventListener("abort", cancel, { once: true })

  const notification = ({ method, params: p }) => {
    if (!threadId || p?.threadId !== threadId) return
    const item = p.item
    if (!turnId && foreground && (method === "item/started" || method === "item/completed")
      && item?.type === "userMessage" && item.clientId === clientId) turnId = p.turnId
    if (!foreground && method === "turn/started" && turnStart && !turnId) turnId = p.turn?.id
    if (settled) return
    if ((p.turnId ?? p.turn?.id) !== turnId || !turnId) return
    if (method === "item/agentMessage/delta" && !completedItems.has(p.itemId)) {
      const entry = messages.get(p.itemId) ?? { text: "" }
      entry.text = (entry.text + p.delta).slice(0, LIMIT)
      messages.set(p.itemId, entry)
      emit(streamStatus(job, "text", p.itemId, p.delta.slice(0, LIMIT)))
    } else if (method === "item/commandExecution/outputDelta" && !completedItems.has(p.itemId)) {
      const output = ((commandOutputs.get(p.itemId) ?? "") + p.delta).slice(-LIMIT)
      commandOutputs.set(p.itemId, output)
      emit(toolStatus(job, { callId: p.itemId, name: "bash", state: "running", output }))
    } else if (method === "item/completed" && item?.type === "agentMessage") {
      if (completedItems.has(item.id)) return
      completedItems.add(item.id)
      messages.set(item.id, { phase: item.phase, text: item.text.slice(0, LIMIT) })
      emit(streamStatus(job, "text", item.id, item.text.slice(0, LIMIT), "replace"))
    } else if ((method === "item/started" || method === "item/completed") && item && toolName(item)) {
      if (completedItems.has(item.id)) return
      const done = method === "item/completed"
      if (done) completedItems.add(item.id)
      const output = item.aggregatedOutput ?? item.error?.message ?? item.result ?? item.contentItems ?? commandOutputs.get(item.id)
      emit(toolStatus(job, {
        callId: item.id,
        name: toolName(item),
        state: done ? (item.status === "completed" ? "completed" : "error") : "running",
        input: item.command ? { command: item.command.slice(0, LIMIT) } : item.changes
          ? { paths: item.changes.slice(0, 100).map(change => change.path) }
          : item.arguments && JSON.stringify(item.arguments).slice(0, LIMIT),
        output: typeof output === "string" ? output.slice(-LIMIT) : output && JSON.stringify(output).slice(0, LIMIT),
      }))
      if (done) commandOutputs.delete(item.id)
    } else if (method === "turn/completed") {
      for (const completed of p.turn.items ?? []) {
        if (completed.type === "agentMessage") messages.set(completed.id, completed)
      }
      if (p.turn.status === "completed") stop({ state: "completed" })
      else if (p.turn.status === "interrupted") stop({ state: "canceled" })
      else fail(p.turn.error?.message?.slice(0, 1000) ?? "Codex 执行失败")
    }
  }
  app.on("notification", notification)

  async function pollForegroundResult() {
    while (!settled) {
      const { data } = await app.call("thread/turns/list", { threadId, limit: 20, itemsView: "full" })
      if (settled) return
      const turn = data.find(candidate => candidate.items.some(item => item.type === "userMessage" && item.clientId === clientId))
      if (turn) {
        turnId = turn.id
        // 独立 App Server 看不到另一进程的运行状态，会把未结束的历史轮次标成 interrupted。
        // 中断或失败须有落盘的结束时间，不能仅凭快照状态提前收尾。
        const terminal = turn.status === "completed"
          || (Number.isFinite(turn.completedAt) && ["interrupted", "failed"].includes(turn.status))
        if (terminal) {
          for (const item of turn.items) {
            notification({ method: "item/completed", params: { threadId, turnId, item } })
          }
          notification({ method: "turn/completed", params: { threadId, turn } })
          return
        }
      }
      await delay(1000)
    }
  }

  const timer = setTimeout(() => stopTask({ state: "failed", reason: `Codex ${mode}任务超时` }), 30 * 60_000)
  try {
    const bootstrap = async () => {
      if (foreground) {
        await prepareForegroundThread(app, threadTarget, cwd, readHistory)
        threadId = threadTarget
      } else {
        await app.initialize()
        const { thread } = await app.call("thread/start", { cwd, ephemeral: true })
        threadId = thread.id
      }
      metadata.session_id = threadId
      if (settled) return
      emit(statusUpdate(job, "working", { metadata }))
      const text = [
        `[Agent Swarm ${mode}任务 ${job.taskId}，发送者 ${job.fromWorkspace || job.caller}]`,
        job.text,
        "直接在最终答复中给出结果。Swarm 会自动回传，请勿再次发送相同答复。",
      ].join("\n\n")
      const input = { threadId, clientUserMessageId: clientId, input: [{ type: "text", text, text_elements: [] }] }
      if (foreground) {
        queued = app.call("thread/queue/add", input).then(({ queuedSubmission }) => {
          submissionId = queuedSubmission.id
        })
        await queued
        if (readHistory && !settled) await pollForegroundResult()
      } else {
        turnStart = app.call("turn/start", input)
        const { turn } = await turnStart
        turnId = turn.id
      }
    }
    if (signal.aborted) cancel()
    else bootstrap().catch(error => {
      if (readHistory && submissionId) {
        stopTask({ state: "failed", reason: error.message.slice(0, 1000) })
      } else {
        fail(foreground ? error.message.slice(0, 1000) : "Codex 无法启动后台任务")
      }
    })
    const outcome = await result
    await cancellation
    await app.close()
    if (outcome.state === "completed") {
      const replies = [...messages.values()].reverse()
      const answer = replies.find(x => x.phase === "final_answer") ?? replies.find(x => !x.phase)
      if (answer?.text) emit(artifactUpdate(job, answer.text.slice(0, LIMIT), true, `artifact-${job.taskId}`))
    }
    emit(statusUpdate(job, outcome.state, {
      final: true, metadata, message: outcome.reason ? agentMessage(outcome.reason, job) : undefined,
    }))
    return outcome.state
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", cancel)
    await app.close()
  }
}
