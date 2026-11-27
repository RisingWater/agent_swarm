import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, truncateSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { startNexusA2AClient, statusUpdate, agentMessage } from "../claude/nexus_a2a.mjs"
import { codexCommand } from "./app-server.mjs"
import { executeTask } from "./background.mjs"
import { callTool, loadConfig } from "./swarm-mcp.mjs"
import { bindForegroundThread, clearForegroundThread, foregroundThread } from "./foreground.mjs"

const LOG_FILE = fileURLToPath(new URL("./worker.log", import.meta.url))
const LOG_MAX_BYTES = 500_000

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
      emit(statusUpdate(job, "failed", { final: true, message: agentMessage("Codex 执行器异常", job) }))
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

function log(line) {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      const text = readFileSync(LOG_FILE, "utf8")
      truncateSync(LOG_FILE, 0)
      appendFileSync(LOG_FILE, text.slice(text.length - LOG_MAX_BYTES / 2))
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // 日志失败不影响任务执行
  }
}

/** 启动后台 worker：注册工作区、心跳并连接 /ws/plugin 接单。
 * 由 worker.mjs 命令行独立运行，或被 Codex 的 MCP 子进程（swarm-mcp.mjs）自动拉起。
 * detached=true 时父进程（MCP 子进程）退出会关闭 stdin，worker 随之停止。 */
export async function startWorker(cwd, { detached = false } = {}) {
  if (typeof WebSocket !== "function") throw new Error("需要 Node.js 22 或以上版本")
  const config = await loadConfig()
  const directory = realpathSync(cwd)
  const [bin, ...prefix] = codexCommand()
  const version = spawnSync(bin, [...prefix, "--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true })
  const match = /^codex-cli (\d+)\.(\d+)\.\d+/m.exec(version.stdout ?? "")
  if (version.status !== 0 || !match || (Number(match[1]) === 0 && Number(match[2]) < 170)) {
    throw new Error("需要 Codex CLI 0.170 或以上版本")
  }
  const hasSwarmMcp = spawnSync(bin, [...prefix, "mcp", "get", "agent-swarm"], {
    cwd: directory, stdio: "ignore", timeout: 15_000, windowsHide: true,
  }).status === 0
  const name = `${basename(directory) || directory}（Codex）`
  const path = directory.replaceAll("\\", "/")
  const info = await callTool(config, "workspace_add", { path, name, agent_type: "codex" })
  const wid = info.workspace_id
  if (!wid || info.status === "disabled") throw new Error("Codex 工作区不可用或已禁用")
  const presence = { workspace_id: wid, agent_type: "codex", session_title: "Codex 执行器" }
  const firstBeat = await callTool(config, "heartbeat", presence)
  if (!firstBeat.ok) throw new Error(firstBeat.message ?? "Codex 工作区心跳未被接受")
  const wsUrl = new URL("/ws/plugin", config.server)
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"
  const receipts = fileURLToPath(new URL(`./receipts/${createHash("sha256").update(config.server + ":" + wid).digest("hex")}/`, import.meta.url))
  const queue = taskQueue(receipts, (job, signal) => executeTask(
    job, directory, event => nexus.sendEvent(event), signal, undefined, { threadTarget: foregroundThread(directory), hasSwarmMcp },
  ),
    event => nexus.sendEvent(event))
  const nexus = startNexusA2AClient({
    url: wsUrl.href, apiKey: config.apiKey, workspaceId: () => wid,
    executionMode: "background", onTask: queue.queue, onTaskCancel: queue.cancel, onRejected: stop, log,
  })
  log(`started ${wid} (${path})${detached ? " [auto]" : ""}`)
  let stopping = false
  let shutdownPromise
  let heartbeat = setTimeout(beat, 30_000)
  async function beat() {
    try {
      const reply = await callTool(config, "heartbeat", presence)
      if (!reply.ok) stop()
    } catch (error) {
      log(`heartbeat failed: ${error.message ?? error}`)
    } finally {
      if (!stopping) heartbeat = setTimeout(beat, 30_000)
    }
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise
    stopping = true
    clearTimeout(heartbeat)
    log("stopping")
    // 等待本地任务发送终态后关闭 WS，在线状态由服务端心跳过期处理。
    shutdownPromise = queue.close().then(() => nexus.close())
    return shutdownPromise
  }
  // 自动启动时 stdin 已被 resume，恢复后进程不会自然退出，等终态发完主动退出。
  function stop() {
    void shutdown().finally(() => process.exit(0))
  }
  if (detached) {
    // 父进程（Codex 的 MCP 子进程）退出时 stdin 关闭；ppid 轮询兜底强杀。
    process.stdin.on("end", stop)
    process.stdin.on("close", stop)
    process.stdin.resume()
    const ppid = process.ppid
    setInterval(() => {
      if (process.ppid !== ppid) stop()
    }, 5_000).unref()
  }
  return { workspaceId: wid, path, shutdown }
}

async function main() {
  const [arg, threadId, directory] = process.argv.slice(2)
  if (arg === "--bind-current") {
    const currentThread = process.env.CODEX_THREAD_ID
    if (!currentThread) throw new Error("请在要绑定的 Codex 会话中运行 $swarm-bind")
    await bindForegroundThread(realpathSync(process.cwd()), currentThread)
    console.log(`Codex 前台会话已绑定：${currentThread}`)
    return
  }
  if (arg === "--bind-thread") {
    if (!threadId) throw new Error("用法：worker.mjs --bind-thread <Codex /status 的 Session ID> [工作目录]")
    await bindForegroundThread(realpathSync(directory ?? process.cwd()), threadId)
    console.log(`Codex 前台会话已绑定：${threadId}`)
    return
  }
  if (arg === "--clear-thread") {
    clearForegroundThread(realpathSync(threadId ?? process.cwd()))
    console.log("后续任务将使用独立后台会话")
    return
  }
  const worker = await startWorker(arg ?? process.cwd(), { detached: process.env.AGENT_SWARM_CODEX_AUTOSTART === "1" })
  process.once("SIGINT", worker.shutdown)
  process.once("SIGTERM", worker.shutdown)
  console.log(`Codex 工作区 ${worker.workspaceId}: ${worker.path.replaceAll("\\", "/")}`)
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch(error => {
    log(`startup failed: ${error.message}`)
    console.error(error.message)
    process.exitCode = 1
  })
}
