import { AppServer, launchCodex } from "./app-server.mjs"
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

// 一个 App Server 仅执行一个独立任务。忽略其他线程、其他 turn 和未公开的推理事件。
export async function executeTask(job, cwd, emit, signal, launch = launchCodex) {
  const app = new AppServer(launch(["app-server", "--listen", "stdio://"], { cwd }))
  const messages = new Map()
  const commandOutputs = new Map()
  const completedItems = new Set()
  let threadId, turnId, turnStart, stop
  let settled = false
  const metadata = { background: true, agent: "codex", message_id: job.messageId }
  const result = new Promise(resolve => {
    stop = outcome => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
  })
  const fail = reason => stop({ state: "failed", reason })
  const cancel = () => {
    if (settled) return
    stop({ state: "canceled" })
    if (threadId && turnId) app.call("turn/interrupt", { threadId, turnId }, 1500).catch(() => {})
  }
  app.on("closed", () => fail("Codex App Server 连接中断"))
  // 后台没有原生审批界面。收到服务端请求就停止该任务，不代答或改变权限配置。
  app.on("request", () => fail("Codex 后台任务需要人工交互，任务已停止"))
  signal.addEventListener("abort", cancel, { once: true })

  app.on("notification", ({ method, params: p }) => {
    if (settled || !threadId || p?.threadId !== threadId) return
    if (method === "turn/started" && turnStart && !turnId) turnId = p.turn?.id
    if ((p.turnId ?? p.turn?.id) !== turnId || !turnId) return
    const item = p.item
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
  })

  const timer = setTimeout(() => fail("Codex 后台任务超时"), 30 * 60_000)
  try {
    const bootstrap = async () => {
      await app.initialize()
      const { thread } = await app.call("thread/start", { cwd, ephemeral: true })
      threadId = thread.id
      metadata.session_id = threadId
      if (signal.aborted) return
      emit(statusUpdate(job, "working", { metadata }))
      const text = [
        `[Agent Swarm 后台任务 ${job.taskId}，发送者 ${job.fromWorkspace || job.caller}]`,
        job.text,
        "直接在最终答复中给出结果。Swarm 会自动回传，请勿再次发送相同答复。",
      ].join("\n\n")
      turnStart = app.call("turn/start", {
        threadId, clientUserMessageId: job.messageId, input: [{ type: "text", text, text_elements: [] }],
      })
      const { turn } = await turnStart
      turnId = turn.id
    }
    if (signal.aborted) cancel()
    else bootstrap().catch(() => fail("Codex 无法启动后台任务"))
    const outcome = await result
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
