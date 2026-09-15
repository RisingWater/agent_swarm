/** agent_swarm claude 后台任务执行器：spawn headless `claude -p` 进程执行 A2A 任务。
 *
 * claude 无前台注入能力（用户决策：claude 只做后台），所有任务走本执行器：
 * - `claude -p <prompt> --output-format stream-json --include-partial-messages --verbose
 *   --dangerously-skip-permissions --max-turns 100`（Windows 下解析真实 exe，npm shim 会 ENOENT）
 * - stdout JSON 事件流逐行解析 → 归一化为 A2A 事件（emit 回调上报，实时回传 web 中枢）：
 *     system/init            → 提取 session_id
 *     thinking_delta         → streamStatus("reasoning")
 *     text_delta             → streamStatus("text")（累积，最后一条 assistant text 作结果）
 *     content_block_start(tool_use) → toolStatus(running)
 *     user.tool_result       → toolStatus(completed/error)
 *     result(is_error=false) → artifact + completed
 * - 会话：由调用方（keepalive.mjs）按来源映射表决定 --resume 或新会话；
 *   resume 被拒（exit≠0 且未见到 session_id，实测 stderr "No conversation found"）
 *   自动去掉 --resume 用新会话重试一次
 * - 超时/取消：Windows taskkill /T /F，POSIX 进程组负 PID；并发上限 MAX_BG_TASKS
 */

import { spawn, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  statusUpdate,
  agentMessage,
  artifactUpdate,
  toolStatus,
  streamStatus,
  taskRef,
} from "./nexus_a2a.mjs"

const BG_TIMEOUT_MS = 30 * 60_000
const MAX_BG_TASKS = 3
const MAX_TURNS = 100

/** 正在运行的后台任务：taskId → 进程句柄 */
const bgProcesses = new Map()

export function backgroundTaskCount() {
  return bgProcesses.size
}

/** Windows 上 npm 全局命令是 .ps1/.cmd shim，Node spawn 直接用名字会 ENOENT；
 *  解析到真实可执行文件（@anthropic-ai/claude-code/bin/claude.exe）或原样返回。 */
function resolveBin(bin) {
  if (bin !== "claude") return bin
  const exe = join(process.env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
  if (process.platform === "win32" && existsSync(exe)) return exe
  return bin
}

/** 杀进程树：POSIX 用进程组负 PID；Windows 用 taskkill /T（无进程组语义） */
function killTree(proc, force = false) {
  if (!proc.pid) {
    try { proc.kill() } catch { /* 已退出 */ }
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

export function cancelBackgroundTask(taskId) {
  const proc = bgProcesses.get(taskId)
  if (!proc) return false
  killTree(proc, false)
  return true
}

export function buildClaudePrompt(taskId, caller, text) {
  return [
    `[agent_swarm A2A 任务 task_id=${taskId}，来自 ${caller}（后台会话）]`,
    "",
    "任务指令：",
    text,
    "",
    "处理要求：",
    "1. 在当前工作区中完成上述任务（查看代码/修改代码/回答问题）。",
    "2. 完成后用一段话总结结果（做了什么/结论/改动点），系统会自动把总结回传给调用方，不要调用任何工具回传。",
    "3. 无法完成时，直接说明原因即可。",
  ].join("\n")
}

/**
 * 执行一个后台 A2A 任务（阻塞到 claude 进程退出）。
 * resumeSessionId：来源映射表记录的续聊会话；空则新会话。续聊被拒时自动回退重试一次。
 * 返回 { ok, sessionId?, finalText?, error? }
 */
export async function runBackgroundTask(task, text, caller, opts, bg) {
  if (bgProcesses.size >= MAX_BG_TASKS) {
    return { ok: false, error: `后台任务并发已满 (${MAX_BG_TASKS})` }
  }

  const bin = resolveBin(opts.claudeBin || "claude")
  const prompt = buildClaudePrompt(task.taskId, caller, text)

  const buildArgs = (resume) => {
    const a = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--include-partial-messages", // 思考/文本 delta 流（实时回传）
      "--verbose", // stream-json 必需（否则只输出最终 result）
      "--dangerously-skip-permissions", // 后台无人值守，全自动批准
      "--max-turns", String(MAX_TURNS),
      // 禁掉 user-scope MCP：否则 claude -p 会再拉起 keepalive 子进程，
      // 同一 workspace_id 多个 WS 连接互相顶号，任务事件流断连丢失
      "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}',
    ]
    if (resume) a.push("--resume", resume)
    return a
  }

  const resume0 = opts.resumeSessionId || ""
  bg.log(`bg ${task.taskId.slice(0, 8)}: spawn claude -p${resume0 ? ` (resume ${resume0.slice(0, 12)})` : " (new session)"}`)
  bg.emit(
    statusUpdate(task, "working", {
      message: {
        role: "user",
        parts: [{ kind: "text", text }],
        messageId: `msg-${task.taskId}-user`,
        taskId: task.taskId,
        contextId: task.contextId,
      },
      metadata: { background: true, cwd: opts.cwd, agent: "claude" },
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

  // 续聊会话失效（--resume 被拒，进程立即失败）：回退新会话重试一次
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

  const { exitCode, sessionId, finalText, stderrTail } = outcome
  if (exitCode === 0 && finalText) {
    bg.emit(artifactUpdate(task, finalText, true, `artifact-${task.taskId}`))
    bg.emit(
      statusUpdate(task, "completed", {
        final: true,
        metadata: { session_id: sessionId, background: true, agent: "claude" },
      }),
    )
    bg.log(`bg ${task.taskId.slice(0, 8)}: completed (${finalText.length} chars)`)
    return { ok: true, sessionId: sessionId || undefined, finalText }
  }

  const reason = exitCode !== 0
    ? `exit code ${exitCode}${stderrTail ? `: ${stderrTail.trim().slice(-300)}` : ""}`
    : "no result text"
  bg.emit(
    statusUpdate(task, "failed", {
      final: true,
      message: agentMessage(`后台任务失败: ${reason}`, task),
      metadata: { session_id: sessionId, background: true, agent: "claude" },
    }),
  )
  bg.log(`bg ${task.taskId.slice(0, 8)}: failed (${reason})`)
  return { ok: false, sessionId: sessionId || undefined, error: reason }
}

/** 单次 spawn claude -p（阻塞到进程退出），stdout 事件流实时归一化上报 */
function spawnOnce(taskId, bin, args, cwd, bg) {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      resolve({ exitCode: -1, sessionId: "", finalText: "", stderrTail: "", resumeRejected: false, spawnError: String(e) })
      return
    }
    bgProcesses.set(taskId, proc)

    let stdoutBuf = ""
    let stderrTail = ""
    let sessionId = ""
    let finalText = ""
    let sawSession = false
    let settled = false
    let blockIdx = 0 // content_block 序号 → part_id（thinking/text 分块流式）

    const timer = setTimeout(() => {
      bg.log(`bg ${taskId.slice(0, 8)}: timeout 30min, killing`)
      killTree(proc, true)
    }, BG_TIMEOUT_MS)

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      bgProcesses.delete(taskId)
      resolve(result)
    }

    /** 处理一行 claude --output-format stream-json 事件（实测形状归一化为 A2A 事件） */
    const handleEvent = (evt) => {
      if (evt.session_id && !sessionId) {
        sessionId = String(evt.session_id)
        sawSession = true
      }
      switch (evt.type) {
        case "stream_event": {
          const e = evt.event ?? {}
          if (e.type === "content_block_start") {
            blockIdx++
            const cb = e.content_block ?? {}
            if (cb.type === "tool_use") {
              // 工具调用开始（input 可能尚未流完，先报 running + 已知 name/id）
              bg.emit(
                toolStatus(taskRef(taskId), {
                  callId: String(cb.id ?? ""),
                  name: String(cb.name ?? "unknown"),
                  state: "running",
                  input: cb.input,
                }),
              )
            }
          } else if (e.type === "content_block_delta") {
            const d = e.delta ?? {}
            if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
              bg.emit(streamStatus(taskRef(taskId), "reasoning", `blk-${blockIdx}`, d.thinking))
            } else if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
              bg.emit(streamStatus(taskRef(taskId), "text", `blk-${blockIdx}`, d.text))
              finalText += d.text // text 块只有最终答复一个（工具轮次的 text 也会累积，最后一条 assistant text 语义上等价于全量拼接）
            }
          }
          break
        }
        case "user": {
          // 工具结果行：message.content[].tool_result
          const content = evt.message?.content
          if (Array.isArray(content)) {
            for (const c of content) {
              if (c?.type === "tool_result") {
                const out = typeof c.content === "string"
                  ? c.content
                  : Array.isArray(c.content)
                    ? c.content.map((p) => p?.text ?? "").join("\n")
                    : ""
                bg.emit(
                  toolStatus(taskRef(taskId), {
                    callId: String(c.tool_use_id ?? ""),
                    name: "tool",
                    state: c.is_error ? "error" : "completed",
                    output: out,
                  }),
                )
              }
            }
          }
          break
        }
        case "result": {
          // 终态行：result 字段是最终 assistant 文本（比 delta 累积更可靠）
          if (evt.is_error) {
            stderrTail = String(evt.result ?? evt.subtype ?? "unknown error")
          } else if (typeof evt.result === "string" && evt.result.trim()) {
            finalText = evt.result
          }
          break
        }
        default:
          break // system/init 之外的 status、assistant 完整行等：信息已由 delta 覆盖
      }
    }

    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString()
      let idx
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim()
        stdoutBuf = stdoutBuf.slice(idx + 1)
        if (!line) continue
        try {
          handleEvent(JSON.parse(line))
        } catch {
          // 非 JSON 行忽略
        }
      }
    })

    proc.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    proc.on("error", (e) => {
      bg.log(`bg ${taskId.slice(0, 8)}: spawn error ${e}`)
      finish({ exitCode: -1, sessionId, finalText, stderrTail, resumeRejected: false, spawnError: String(e) })
    })

    proc.on("close", (code) => {
      // resume 被拒的特征：带 --resume 启动失败 → 非零退出 + 从未见过 session_id
      const resumeRejected = !sawSession && (code ?? 1) !== 0
      finish({ exitCode: code ?? -1, sessionId, finalText, stderrTail, resumeRejected })
    })
  })
}
