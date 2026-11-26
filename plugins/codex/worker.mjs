import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { startNexusA2AClient, statusUpdate, agentMessage } from "../claude/nexus_a2a.mjs"
import { codexCommand } from "./app-server.mjs"
import { executeTask } from "./background.mjs"
import { callTool, loadConfig } from "./swarm-mcp.mjs"

export function taskQueue(receipts, execute, emit) {
  mkdirSync(receipts, { recursive: true, mode: 0o700 })
  const jobs = new Map()
  let active = null
  let closing
  let closeDone

  function receipt(taskId) {
    return join(receipts, createHash("sha256").update(taskId).digest("hex"))
  }

  // 写下接单记录后才确认 RPC。重启遇到未知结果时禁止重跑已有副作用的任务。
  function queue(task, text, caller, messageId, fromWorkspace) {
    if (closing) throw new Error("Codex worker is stopping")
    if (jobs.has(task.taskId)) return ""
    if (jobs.size >= 100) throw new Error("Codex worker queue is full")
    const file = receipt(task.taskId)
    try {
      writeFileSync(file, "accepted", { flag: "wx", mode: 0o600 })
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const state = readFileSync(file, "utf8")
      setImmediate(() => emit(statusUpdate(task, ["completed", "canceled"].includes(state) ? state : "failed", {
        final: true, message: state === "accepted" ? agentMessage("任务已被接收，适配器重启后无法确认执行结果", task) : undefined,
      })))
      return ""
    }
    jobs.set(task.taskId, {
      ...task, contextId: task.contextId || task.taskId, text, caller, messageId, fromWorkspace,
      control: new AbortController(),
    })
    setImmediate(runNext)
    return ""
  }

  function finish(job, state) {
    jobs.delete(job.taskId)
    try { writeFileSync(receipt(job.taskId), state, { mode: 0o600 }) } catch { /* 保留接单记录 */ }
  }

  function cancel(taskId) {
    const job = jobs.get(taskId)
    if (!job) return
    if (job === active) job.control.abort()
    else {
      finish(job, "canceled")
      emit(statusUpdate(job, "canceled", { final: true }))
    }
  }

  async function runNext() {
    if (closing || active || !jobs.size) return
    const job = jobs.values().next().value
    active = job
    let state = "failed"
    try {
      state = await execute(job, job.control.signal)
    } catch {
      emit(statusUpdate(job, "failed", { final: true, message: agentMessage("Codex 后台执行器异常", job) }))
    } finally {
      finish(job, state)
      active = null
      if (closing) closeDone?.()
      else setImmediate(runNext)
    }
  }

  return { queue, cancel, close() {
    if (closing) return closing
    closing = active ? new Promise(resolve => { closeDone = resolve }) : Promise.resolve()
    for (const taskId of jobs.keys()) cancel(taskId)
    return closing
  } }
}

async function main() {
  if (typeof WebSocket !== "function") throw new Error("需要 Node.js 22 或以上版本")
  const config = await loadConfig()
  const cwd = realpathSync(process.argv[2] ?? process.cwd())
  const [bin, ...prefix] = codexCommand()
  const version = spawnSync(bin, [...prefix, "--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true })
  const match = /^codex-cli (\d+)\.(\d+)\.\d+/m.exec(version.stdout ?? "")
  if (version.status !== 0 || !match || (Number(match[1]) === 0 && Number(match[2]) < 170)) {
    throw new Error("需要 Codex CLI 0.170 或以上版本")
  }
  const name = `${basename(cwd) || cwd}（Codex 后台）`
  const path = cwd.replaceAll("\\", "/")
  const info = await callTool(config, "workspace_add", { path, name, agent_type: "codex" })
  const wid = info.workspace_id
  if (!wid || info.status === "disabled") throw new Error("Codex 工作区不可用或已禁用")
  const wsUrl = new URL("/ws/plugin", config.server)
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"
  const receipts = fileURLToPath(new URL(`./receipts/${createHash("sha256").update(config.server + ":" + wid).digest("hex")}/`, import.meta.url))
  const queue = taskQueue(receipts, (job, signal) => executeTask(job, cwd, event => nexus.sendEvent(event), signal),
    event => nexus.sendEvent(event))
  const nexus = startNexusA2AClient({
    url: wsUrl.href, apiKey: config.apiKey, workspaceId: () => wid,
    executionMode: "background", onTask: queue.queue, onTaskCancel: queue.cancel, onRejected: shutdown, log: console.error,
  })
  let stopping = false
  let heartbeat = setTimeout(beat, 30_000)
  async function beat() {
    try {
      const reply = await callTool(config, "heartbeat", { workspace_id: wid, agent_type: "codex", session_title: "Codex 后台执行器" })
      if (!reply.ok) shutdown()
    } catch {
      console.error("Codex 工作区心跳失败，将重试")
    } finally {
      if (!stopping) heartbeat = setTimeout(beat, 30_000)
    }
  }
  function shutdown() {
    if (stopping) return
    stopping = true
    clearTimeout(heartbeat)
    // 等待本地发送终态后关闭 WS，在线状态由服务端心跳过期处理。
    void queue.close().then(() => nexus.close())
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  console.log(`Codex 后台工作区 ${wid}: ${path}`)
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
