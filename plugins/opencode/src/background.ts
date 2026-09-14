/** agent_swarm 后台任务执行器：spawn headless opencode 进程执行 A2A 任务。
 *
 * 与前台注入（executeTaskForeground）的差别：
 * - 不碰当前 TUI 会话：spawn `opencode run --format json --auto` 子进程
 * - stdout JSON 事件流逐行解析 → 归一化为与前台完全一致的 A2A 事件（emit 回调上报）
 * - 进程退出即任务完成（exit code + 最终 assistant 文本决定 completed/failed）
 * - 权限策略：--auto 全自动批准（用户决策：后台始终 auto-approve）
 * - 会话锚点：服务端派发时在 metadata.session_id 带上工作区当前会话（heartbeat 上报的），
 *   有则 --session 续聊（后台进程的对话就落在服务端指定的这个会话里），无则新会话
 * - 超时/取消：kill 进程树；并发上限 MAX_BG_TASKS
 */

import { spawn, type ChildProcess } from "node:child_process"
import type { A2aTaskRef } from "./nexus_a2a"
import {
  statusUpdate,
  agentMessage,
  artifactUpdate,
  toolStatus,
  streamStatus,
} from "./nexus_a2a"

const BG_TIMEOUT_MS = 30 * 60_000
const MAX_BG_TASKS = 3

/** 正在运行的后台任务：taskId → 进程句柄 */
const bgProcesses = new Map<string, ChildProcess>()

export function backgroundTaskCount(): number {
  return bgProcesses.size
}

export function cancelBackgroundTask(taskId: string): boolean {
  const proc = bgProcesses.get(taskId)
  if (!proc) return false
  try {
    // 杀进程树：负 PID 信号（POSIX）；失败退回直接 kill
    if (proc.pid) {
      try {
        process.kill(-proc.pid, "SIGTERM")
      } catch {
        proc.kill("SIGTERM")
      }
    } else {
      proc.kill("SIGTERM")
    }
  } catch {
    /* 进程可能已退出 */
  }
  return true
}

/** opencode --format json 的 stdout 事件（实测形状，与 SSE event hook 的事件名不同）：
 *   {type:"text",        sessionID, part:{type:"text", text, ...}}
 *   {type:"tool_use",    sessionID, part:{type:"tool", tool, callID, state:{status,input,output}}}
 *   {type:"step_start"|"step_finish", sessionID, part:{...}}   → 忽略
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

/**
 * 执行一个后台 A2A 任务（阻塞到进程退出）。
 * sessionId 来自服务端派发（metadata.session_id = heartbeat 上报的工作区当前会话），
 * 有则续聊该会话，无则新开会话。
 */
export async function runBackgroundTask(
  task: A2aTaskRef,
  text: string,
  caller: string,
  opts: {
    cwd: string
    opencodeBin?: string
    sessionId?: string // 服务端指定的工作区当前会话（续聊锚点）
  },
  bg: BgEmit,
): Promise<BgRunResult> {
  if (bgProcesses.size >= MAX_BG_TASKS) {
    return { ok: false, error: `后台任务并发已满 (${MAX_BG_TASKS})` }
  }

  const bin = opts.opencodeBin || "opencode"
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

  const args = [
    "run",
    prompt,
    "--format", "json",
    "--auto", // 权限全自动批准（后台无人值守）
    "--title", `A2A-${task.taskId.slice(0, 8)}`,
  ]
  const resumeSession = opts.sessionId || ""
  if (resumeSession) args.push("--session", resumeSession)

  bg.log(`bg ${task.taskId.slice(0, 8)}: spawn ${bin} run${resumeSession ? ` (resume ${resumeSession.slice(0, 12)})` : ""}`)
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

  return new Promise<BgRunResult>((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(bin, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // 进程组：cancel 时可整树杀
      })
    } catch (e) {
      resolve({ ok: false, error: `spawn failed: ${e}` })
      return
    }
    bgProcesses.set(task.taskId, proc)

    let stdoutBuf = ""
    let stderrTail = ""
    let sessionId = resumeSession || ""
    let finalText = ""
    let settled = false

    const timer = setTimeout(() => {
      bg.log(`bg ${task.taskId.slice(0, 8)}: timeout 30min, killing`)
      if (proc.pid) {
        try { process.kill(-proc.pid, "SIGKILL") } catch { proc.kill("SIGKILL") }
      }
    }, BG_TIMEOUT_MS)

    const finish = (result: BgRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      bgProcesses.delete(task.taskId)
      resolve(result)
    }

    /** 处理一个 opencode --format json 事件（实测形状归一化为 A2A 事件） */
    const handleOcEvent = (evt: OcEvent) => {
      if (evt.sessionID && !sessionId) sessionId = String(evt.sessionID)
      const part = (evt.part ?? {}) as Record<string, any>

      if (evt.type === "text" || part?.type === "text") {
        const textPart = part.type ? part : (evt as any).part ?? {}
        if (!textPart.synthetic && typeof textPart.text === "string" && textPart.text.trim()) {
          bg.emit(streamStatus(task, "text", String(textPart.id ?? ""), textPart.text))
          finalText = textPart.text // text 事件为全量快照，最后一条即完整文本
        }
      } else if (evt.type === "tool_use" || part?.type === "tool") {
        const toolPart = part.type ? part : (evt as any).part ?? {}
        const stateObj = toolPart.state ?? {}
        const rawStatus = stateObj.status ?? "running"
        if (rawStatus === "pending") return
        const state = rawStatus === "completed" || rawStatus === "error" ? rawStatus : "running"
        bg.emit(
          toolStatus(task, {
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
      bg.log(`bg ${task.taskId.slice(0, 8)}: spawn error ${e}`)
      bg.emit(
        statusUpdate(task, "failed", {
          final: true,
          message: agentMessage(`后台进程启动失败: ${e}`, task),
          metadata: { background: true },
        }),
      )
      finish({ ok: false, sessionId: sessionId || undefined, error: String(e) })
    })

    proc.on("close", (code, signal) => {
      if (signal) bg.log(`bg ${task.taskId.slice(0, 8)}: killed by ${signal}`)
      if (code === 0 && finalText) {
        bg.emit(artifactUpdate(task, finalText, true, `artifact-${task.taskId}`))
        bg.emit(
          statusUpdate(task, "completed", {
            final: true,
            metadata: { session_id: sessionId, background: true },
          }),
        )
        bg.log(`bg ${task.taskId.slice(0, 8)}: completed (${finalText.length} chars)`)
        finish({ ok: true, sessionId: sessionId || undefined, finalText })
      } else {
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
        finish({ ok: false, sessionId: sessionId || undefined, error: reason })
      }
    })
  })
}

/** 后台任务 prompt 构造器（测试/调试用） */
export function buildBackgroundPrompt(taskId: string, caller: string, text: string): string[] {
  return ["run", "--format", "json", "--auto"]
    .concat(["--title", `A2A-${taskId.slice(0, 8)}`])
    .concat([text])
}
