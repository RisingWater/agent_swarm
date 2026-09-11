/** agent_swarm opencode 插件主入口 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { SwarmClient, type HelpTask } from "./client"
import { loadConfig } from "./config"
import { summarizeWithLLM } from "./summarize"

const HEARTBEAT_TIMEOUT = 10_000
const POLL_TIMEOUT = 8_000

const plugin: Plugin = async (input) => {
  const { client, directory } = input
  const cfg = loadConfig()
  if (!cfg) {
    // 未配置 apikey：插件静默不启用
    return {}
  }
  const teamName: string | undefined = cfg.teamName
  const heartbeatMs = cfg.heartbeatIntervalMs ?? 30_000
  const pollMs = cfg.pollIntervalMs ?? 10_000
  const swarm = new SwarmClient(cfg)

  let workspaceId = ""
  let currentSessionId = ""
  let disposed = false
  const inflight = new Set<string>() // 已 accept 待提交结果的 request_id

  function log(msg: string) {
    console.log(`[agent-swarm] ${msg}`)
  }

  // ---------------- 注册 + 心跳 ----------------

  async function register() {
    // 先注册（不带总结），仅当服务端提示缺总结时才调 LLM
    const r = await swarm.registerWorkspace({
      path: directory,
      teamName,
    })
    workspaceId = r.workspace_id
    log(`workspace registered: ${r.name} (${workspaceId}) created=${r.created}`)
    if (r.need_summary) {
      log("no summary yet, asking LLM...")
      await summarizeAndSave()
    } else {
      log(`purpose: ${(r.purpose ?? "").slice(0, 50)}`)
    }
  }

  /** 调 LLM 总结目录并回写到服务端（注册时缺总结 / /swarm-resummarize 手动触发） */
  async function summarizeAndSave() {
    const { purpose, capabilities } = await summarizeWithLLM(client, directory)
    await swarm.updateInfo(workspaceId, purpose, capabilities)
    log(`summary saved: ${purpose.slice(0, 50)}`)
  }

  async function heartbeatLoop() {
    while (!disposed) {
      try {
        if (workspaceId) await swarm.heartbeat(workspaceId, currentSessionId || undefined)
      } catch (e) {
        log(`heartbeat failed: ${e}`)
      }
      await new Promise((r) => setTimeout(r, heartbeatMs))
    }
  }

  register()
    .then(() => heartbeatLoop())
    .catch((e) => log(`register failed: ${e}`))

  // ---------------- 任务 prompt 构造 ----------------

  function buildTaskPrompt(task: HelpTask): string {
    const requester = task.requester
    return [
      `[agent_swarm 求助任务 request_id=${task.request_id}]`,
      requester
        ? `来自工作区「${requester.name}」（${requester.path}，用途：${requester.purpose}）`
        : "来自其他工作区",
      "",
      "求助内容：",
      task.question,
      "",
      "处理要求：",
      "1. 根据求助内容在当前工作区中调查并完成任务（查看代码/修改代码/回答问题）。",
      `2. 完成后必须调用 swarm_submit_help 工具提交结果（request_id="${task.request_id}"）。`,
      "3. 如果无法完成，也用 swarm_submit_help 提交 ok=false 和原因。",
    ].join("\n")
  }

  // ---------------- 领任务执行（双模式） ----------------

  async function pollLoop() {
    await new Promise((r) => setTimeout(r, 3_000)) // 等首次注册
    while (!disposed) {
      try {
        if (workspaceId) {
          const { requests } = await swarm.pollHelpRequests(workspaceId)
          for (const task of requests) {
            log(`received help task ${task.request_id} mode=${task.mode}`)
            executeTask(task).catch((e) => log(`execute failed: ${e}`))
          }
        }
      } catch (e) {
        log(`poll failed: ${e}`)
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  async function executeTask(task: HelpTask) {
    const prompt = buildTaskPrompt(task)
    if (task.mode === "foreground") {
      // 前台：注入当前 TUI 会话，自动执行
      await client.tui
        .showToast({
          body: {
            message: `收到来自 ${task.requester?.name ?? "其他工作区"} 的求助`,
            variant: "info",
          },
        })
        .catch(() => {})
      await client.tui.appendPrompt({ body: { text: prompt } })
      await client.tui.submitPrompt({})
      inflight.add(task.request_id)
    } else {
      // 后台：指定会话或新建会话
      let sessionId = task.session_id ?? ""
      if (sessionId) {
        await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: prompt }] },
        })
      } else {
        const created: any = await client.session.create({
          body: { title: `swarm-help-${task.request_id.slice(0, 8)}` },
        })
        sessionId = created?.data?.id ?? created?.id ?? ""
        if (!sessionId) throw new Error("session create failed")
        await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: prompt }] },
        })
      }
      inflight.add(task.request_id)
      log(`background task ${task.request_id} dispatched to session ${sessionId}`)
    }
  }

  // ---------------- 结果兜底（session idle 事件） ----------------

  const idleProbe = new Map<string, number>() // request_id -> last idle probe time

  async function fallbackSubmit() {
    if (inflight.size === 0) return
    for (const requestId of [...inflight]) {
      const res = await swarm.getHelpResult(requestId).catch(() => null)
      if (!res) continue
      if (res.status === "done" || res.status === "failed") {
        inflight.delete(requestId)
        idleProbe.delete(requestId)
      }
    }
  }

  pollLoop().catch(() => {})
  // 兜底：每次 poll 循环顺带检查 inflight（agent 主动提交后 inflight 会清掉）
  const fallbackLoop = async () => {
    while (!disposed) {
      await fallbackSubmit()
      await new Promise((r) => setTimeout(r, 15_000))
    }
  }
  fallbackLoop()

  return {
    // 跟踪当前会话 id（前台注入与心跳上报用）
    event: async ({ event }) => {
      const anyEvt = event as any
      const sid = anyEvt?.properties?.sessionID ?? anyEvt?.info?.sessionID
      if (typeof sid === "string" && sid) currentSessionId = sid
    },

    // ---------------- 自定义命令 ----------------

    // /swarm-note <内容>：追加工作区备注；/swarm-desc <描述>：更新描述；
    // /swarm-resummarize：手动触发 LLM 重新总结目录
    "command.execute.before": async ({ command, arguments: args }) => {
      if (command !== "swarm-note" && command !== "swarm-desc" && command !== "swarm-resummarize")
        return
      // 阻止默认执行：通过抛错中断命令流（opencode 会展示错误但命令不会发给 LLM）
      if (!workspaceId) throw new Error("agent_swarm: 工作区尚未注册成功")
      const content = (args ?? "").trim()
      if (command === "swarm-note") {
        if (!content) throw new Error("用法: /swarm-note <内容>")
        await swarm.updateNotes(workspaceId, content, true)
        throw new Error(`agent_swarm: 备注已追加 ✓`)
      } else if (command === "swarm-desc") {
        if (!content) throw new Error("用法: /swarm-desc <描述>")
        await swarm.updateInfo(workspaceId, content)
        throw new Error(`agent_swarm: 工作区描述已更新 ✓`)
      } else {
        throw new Error(
          await summarizeAndSave()
            .then(() => "agent_swarm: 已重新总结目录用途 ✓")
            .catch((e) => `agent_swarm: 总结失败 - ${e}`),
        )
      }
    },

    // ---------------- 工具注入 ----------------

    tool: {
      swarm_list_workspaces: tool({
        description:
          "列出 agent_swarm 中当前用户/团队可见的在线 agent 工作区（包含各自用途与能力）。需要向其他 agent 寻求帮助前，先用它找到目标工作区 ID。",
        args: {},
        async execute() {
          if (!workspaceId) return "agent_swarm: 插件未注册（检查 apikey 配置）"
          const { workspaces } = await swarm.listWorkspaces()
          if (!workspaces.length) return "当前没有其他在线工作区。"
          return workspaces
            .map(
              (w) =>
                `- [${w.workspace_id}] ${w.name} (${w.owner}${w.is_self ? ", 自己" : ""})\n  路径: ${w.path}\n  用途: ${w.purpose}\n  能力: ${w.capabilities ?? "-"}${w.notes ? `\n  备注: ${w.notes.split("\n").slice(-2).join(" / ")}` : ""}`,
            )
            .join("\n")
        },
      }),

      swarm_request_help: tool({
        description:
          "向 agent_swarm 中另一个在线工作区的 agent 发起求助（异步）。返回 request_id，之后用 swarm_get_help_result 轮询结果。适合：询问对方项目实现细节、请对方帮忙修改其工作区代码等。",
        args: {
          target_workspace_id: z.string().describe("目标工作区 ID（从 swarm_list_workspaces 获取）"),
          question: z.string().describe("求助问题描述，尽量带上下文：相关文件路径、报错信息、期望结果"),
          mode: z
            .enum(["background", "foreground"])
            .optional()
            .describe("background=对方新会话后台执行（默认）；foreground=注入对方当前会话（对方用户可见，响应更快）"),
        },
        async execute(args) {
          if (!workspaceId) return "agent_swarm: 插件未注册（检查 apikey 配置）"
          const r = await swarm.requestHelp({
            requesterWorkspaceId: workspaceId,
            targetWorkspaceId: args.target_workspace_id,
            question: args.question,
            mode: args.mode ?? "background",
          })
          return [
            `求助已提交 request_id=${r.request_id} status=${r.status}`,
            `请稍后用 swarm_get_help_result(request_id="${r.request_id}") 轮询结果。`,
          ].join("\n")
        },
      }),

      swarm_get_help_result: tool({
        description: "查询之前发出的 swarm 求助任务的结果/状态。",
        args: {
          request_id: z.string().describe("swarm_request_help 返回的请求 ID"),
        },
        async execute(args) {
          const r = await swarm.getHelpResult(args.request_id)
          if (r.status === "done") return `状态: done\n结果:\n${r.result ?? "(空)"}`
          if (r.status === "failed") return `状态: failed\n原因: ${r.error ?? "(未提供)"}`
          return `状态: ${r.status}（目标 agent 还在处理中，可稍后再查）`
        },
      }),

      swarm_submit_help: tool({
        description:
          "提交 agent_swarm 求助任务的执行结果。当你处理完注入到本会话的 swarm 求助任务后，用请求中给出的 request_id 调用此工具。",
        args: {
          request_id: z.string().describe("求助任务中的 request_id"),
          ok: z.boolean().describe("是否成功完成"),
          result: z.string().describe("结果内容：修改说明/答案；失败时填原因"),
        },
        async execute(args) {
          await swarm.submitHelpResult(args.request_id, args.ok, args.result)
          inflight.delete(args.request_id)
          return `结果已提交（status=${args.ok ? "done" : "failed"}）`
        },
      }),
    },

    dispose: async () => {
      disposed = true
    },
  }
}

export default plugin
