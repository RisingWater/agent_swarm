/** agent_swarm 后台任务执行器：spawn headless opencode 进程执行 A2A 任务。
 *
 * 与前台注入（executeTaskForeground）的差别：
 * - 不碰当前 TUI 会话：spawn `opencode run --format json --auto` 子进程
 * - V2：opencode run 只是客户端，插件由后台 service 加载，子进程不会再起插件实例，
 *   因此不需要 V1 的 --pure（V2 也已经删掉了该标志）
 * - --thinking：stdout 输出 reasoning 事件（实时回传 web 中枢展示思考过程）
 * - stdout JSON 事件流逐行解析 → 归一化为与前台完全一致的 A2A 事件（emit 回调上报）
 * - 进程退出即任务完成（exit code + 最终 assistant 文本决定 completed/failed）
 * - 权限策略：--auto 全自动批准（用户决策：后台始终 auto-approve）
 * - 会话：由调用方（index.ts）按来源映射表决定续聊或新会话；--session 被拒时
 *   （进程非零退出且未产生任何事件）自动去掉 --session 用新会话重试一次
 * - 超时/取消：kill 进程树；并发上限 MAX_BG_TASKS
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { A2aTaskRef } from "../nexus_a2a"
import {
  statusUpdate,
  agentMessage,
  artifactUpdate,
  toolStatus,
  streamStatus,
} from "../nexus_a2a"

const BG_TIMEOUT_MS = 30 * 60_000
const MAX_BG_TASKS = 3

/** 正在运行的后台任务：taskId → 进程句柄 */
const bgProcesses = new Map<string, ChildProcess>()

export function backgroundTaskCount(): number {
  return bgProcesses.size
}

/** Windows 上 npm 全局命令是 .cmd shim，Node spawn 直接用名字会 ENOENT；
 *  解析到真实可执行文件（@opencode/cli/bin/opencode.exe）或 .cmd 全路径。 */
function resolveBin(bin: string): string {
  if (bin !== "opencode") return bin // 自定义命令按原样使用
  const exe = join(process.env.APPDATA ?? "", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe")
  if (process.platform === "win32" && existsSync(exe)) return exe
  return bin
}

/** 杀进程树：POSIX 用进程组负 PID；Windows 用 taskkill /T（无进程组语义） */
function killTree(proc: ChildProcess, force = false): void {
  if (!proc.pid) {
    proc.kill("SIGTERM")
    return
  }
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      try { proc.kill() } catch { /* 已退出 */ }
    }
    return
  }
  try {
    process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM")
  } catch {
    try { proc.kill(force ? "SIGKILL" : "SIGTERM") } catch { /* 已退出 */ }
  }
}

export function cancelBackgroundTask(taskId: string): boolean {
  const proc = bgProcesses.get(taskId)
  if (!proc) return false
  killTree(proc, false)
  return true
}

/** opencode --format json 的 stdout 事件（实测形状，与 SSE event hook 的事件名不同）：
 *   {type:"text",      sessionID, part:{type:"text", id, text, time:{start,end}}}
 *   {type:"reasoning", sessionID, part:{type:"reasoning", id, text}}        → 需 --thinking
 *   {type:"tool_use",  sessionID, part:{type:"tool", tool, callID,
 *                                     state:{status,input,output,metadata}}}
 *   {type:"step_start"|"step_finish", sessionID, part:{type:"step-start"|...}} → 忽略
 */
type OcEvent = { type?: string; sessionID?: string; part?: Record<string, any> }

export interface BgRunResult {
  ok: boolean
  sessionId?: string
  finalText?: string
  error?: string
}

export interface BgEmit {
  /** 上报 A2A 事件（与前台 a2aEmit 相同通道） */
  emit: (event: Record<string, unknown>) => void
  log: (msg: string) => void
}

interface SpawnOutcome {
  code: number
  signal: NodeJS.Signals | null
  sessionId: string
  finalText: string
  stderrTail: string
  /** resume 会话被拒：带 --session 启动即失败（非零退出且无任何 stdout 事件/sessionID） */
  resumeRejected: boolean
  spawnError?: string
}

function taskRef(taskId: string): A2aTaskRef {
  return { taskId, contextId: taskId }
}

/** 单次 spawn opencode run（阻塞到进程退出），stdout 事件流实时归一化上报 */
function spawnOnce(
  taskId: string,
  bin: string,
  args: string[],
  cwd: string,
  bg: BgEmit,
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(bin, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // 进程组：cancel 时可整树杀
      })
    } catch (e) {
      resolve({ code: -1, signal: null, sessionId: "", finalText: "", stderrTail: "", resumeRejected: false, spawnError: String(e) })
      return
    }
    bgProcesses.set(taskId, proc)

    let stdoutBuf = ""
    let stderrTail = ""
    let sessionId = ""
    let finalText = ""
    let sawEvent = false
    let settled = false

    const timer = setTimeout(() => {
      bg.log(`bg ${taskId.slice(0, 8)}: timeout 30min, killing`)
      killTree(proc, true)
    }, BG_TIMEOUT_MS)

    const finish = (result: SpawnOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      bgProcesses.delete(taskId)
      resolve(result)
    }

    /** 处理一个 opencode --format json 事件（实测形状归一化为 A2A 事件） */
    const handleOcEvent = (evt: OcEvent) => {
      if (evt.sessionID && !sessionId) sessionId = String(evt.sessionID)
      const part = (evt.part ?? {}) as Record<string, any>

      if (evt.type === "text" || part?.type === "text") {
        const textPart = part.type ? part : (evt as any).part ?? {}
        if (!textPart.synthetic && typeof textPart.text === "string" && textPart.text.trim()) {
          bg.emit(streamStatus(taskRef(taskId), "text", String(textPart.id ?? ""), textPart.text))
          finalText = textPart.text // text 事件为全量快照，最后一条即完整文本
        }
      } else if (evt.type === "reasoning" || part?.type === "reasoning") {
        // --thinking 输出的思考流（形状与前台 SSE reasoning part 一致）
        if (typeof part.text === "string" && part.text.trim()) {
          bg.emit(streamStatus(taskRef(taskId), "reasoning", String(part.id ?? ""), part.text))
        }
      } else if (evt.type === "tool_use" || part?.type === "tool") {
        const toolPart = part.type ? part : (evt as any).part ?? {}
        const stateObj = toolPart.state ?? {}
        const rawStatus = stateObj.status ?? "running"
        if (rawStatus === "pending") return
        const state = rawStatus === "completed" || rawStatus === "error" ? rawStatus : "running"
        bg.emit(
          toolStatus(taskRef(taskId), {
            callId: String(toolPart.callID ?? ""),
            name: String(toolPart.tool ?? "unknown"),
            state,
            input: stateObj.input,
            output: stateObj.output,
          }),
        )
      }
      // step_start / step_finish / 其他类型忽略
    }

    proc.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString()
      let idx: number
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (!line) continue
        sawEvent = true
        try {
          const evt = JSON.parse(line)
          if (evt.type || evt.part) handleOcEvent(evt as OcEvent)
          else if (evt.sessionID && !sessionId) sessionId = String(evt.sessionID)
        } catch {
          // 非 JSON 行忽略
        }
      }
    })

    proc.stderr!.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    proc.on("error", (e) => {
      bg.log(`bg ${taskId.slice(0, 8)}: spawn error ${e}`)
      finish({ code: -1, signal: null, sessionId, finalText, stderrTail, resumeRejected: false, spawnError: String(e) })
    })

    proc.on("close", (code, signal) => {
      if (signal) bg.log(`bg ${taskId.slice(0, 8)}: killed by ${signal}`)
      // resume 被拒的特征：带 --session 启动失败 → 非零退出 + 无任何 stdout 事件
      const resumeRejected = !sawEvent && !sessionId && (code ?? 1) !== 0
      finish({
        code: code ?? -1,
        signal,
        sessionId,
        finalText,
        stderrTail,
        resumeRejected,
      })
    })
  })
}

/**
 * 执行一个后台 A2A 任务（阻塞到进程退出）。
 * resumeSessionId：来源映射表记录的续聊会话（同 caller 上一次的后台会话）；
 * 空则新开会话（标题 A2A-<taskId>）。续聊被拒时自动回退新会话重试一次。
 */
export async function runBackgroundTask(
  task: A2aTaskRef,
  text: string,
  caller: string,
  opts: {
    cwd: string
    opencodeBin?: string
    resumeSessionId?: string // 来源映射表命中的续聊会话
  },
  bg: BgEmit,
): Promise<BgRunResult> {
  if (bgProcesses.size >= MAX_BG_TASKS) {
    return { ok: false, error: `后台任务并发已满 (${MAX_BG_TASKS})` }
  }

  const bin = resolveBin(opts.opencodeBin || "opencode")
  const prompt = [
    `[agent_swarm A2A 任务 task_id=${task.taskId}，来自 ${caller}（后台会话）]`,
    "",
    "任务指令：",
    text,
    "",
    "处理要求：",
    "1. 在当前工作区中完成上述任务（查看代码/修改代码/回答问题）。",
    "2. 完成后用一段话总结结果（做了什么/结论/改动点），系统会自动把总结回传给调用方，不要调用任何工具回传。",
    "3. 无法完成时，直接说明原因即可。",
  ].join("\n")

  const buildArgs = (resume: string) => {
    const a = [
      "run",
      prompt,
      "--format", "json",
      "--thinking", // stdout 输出 reasoning 事件（实时回传 web 展示）
      "--auto", // 权限全自动批准（后台无人值守）
      "--title", `A2A-${task.taskId.slice(0, 8)}`,
    ]
    if (resume) a.push("--session", resume)
    return a
  }

  const resume0 = opts.resumeSessionId || ""
  bg.log(`bg ${task.taskId.slice(0, 8)}: spawn ${bin} run${resume0 ? ` (resume ${resume0.slice(0, 12)})` : " (new session)"}`)
  bg.emit(
    statusUpdate(task, "working", {
      message: {
        role: "user",
        parts: [{ kind: "text", text }],
        messageId: `msg-${task.taskId}-user`,
        taskId: task.taskId,
        contextId: task.contextId,
      },
      metadata: { background: true, cwd: opts.cwd },
    }),
  )

  let outcome = await spawnOnce(task.taskId, bin, buildArgs(resume0), opts.cwd, bg)
  if (outcome.spawnError) {
    bg.emit(
      statusUpdate(task, "failed", {
        final: true,
        message: agentMessage(`后台进程启动失败: ${outcome.spawnError}`, task),
        metadata: { background: true },
      }),
    )
    return { ok: false, sessionId: outcome.sessionId || undefined, error: `spawn failed: ${outcome.spawnError}` }
  }

  // 续聊会话失效（--session 被拒，进程立即失败）：回退新会话重试一次
  if (outcome.resumeRejected && resume0) {
    bg.log(`bg ${task.taskId.slice(0, 8)}: resume rejected (${resume0.slice(0, 12)}), retrying with new session`)
    outcome = await spawnOnce(task.taskId, bin, buildArgs(""), opts.cwd, bg)
    if (outcome.spawnError) {
      bg.emit(
        statusUpdate(task, "failed", {
          final: true,
          message: agentMessage(`后台进程启动失败: ${outcome.spawnError}`, task),
          metadata: { background: true },
        }),
      )
      return { ok: false, sessionId: outcome.sessionId || undefined, error: `spawn failed: ${outcome.spawnError}` }
    }
  }

  const { code, signal, sessionId, finalText, stderrTail } = outcome
  if (code === 0 && finalText) {
    bg.emit(artifactUpdate(task, finalText, true, `artifact-${task.taskId}`))
    bg.emit(
      statusUpdate(task, "completed", {
        final: true,
        metadata: { session_id: sessionId, background: true },
      }),
    )
    bg.log(`bg ${task.taskId.slice(0, 8)}: completed (${finalText.length} chars)`)
    return { ok: true, sessionId: sessionId || undefined, finalText }
  }

  const reason = signal
    ? `terminated by ${signal}`
    : code !== 0
      ? `exit code ${code}${stderrTail ? `: ${stderrTail.trim().slice(-300)}` : ""}`
      : "no result text"
  bg.emit(
    statusUpdate(task, "failed", {
      final: true,
      message: agentMessage(`后台任务失败: ${reason}`, task),
      metadata: { session_id: sessionId, background: true },
    }),
  )
  bg.log(`bg ${task.taskId.slice(0, 8)}: failed (${reason})`)
  return { ok: false, sessionId: sessionId || undefined, error: reason }
}
