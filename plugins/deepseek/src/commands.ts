/** /swarm-* 命令（dsh commands 注册表）。
 *
 * dsh 命令是插件经 ctx.commands.register() 注册的 UI 直执行器（不经模型），
 * 与 opencode/claude 的 markdown 命令机制不同。
 *
 * 对齐 opencode 命令集的常用子集：
 *   /swarm-add       注册当前目录为工作区（写 .agent_swarm/workspace.md）
 *   /swarm-remove    注销当前工作区
 *   /swarm-enable    启用当前工作区
 *   /swarm-disable   禁用当前工作区（禁用后心跳不复活）
 *   /swarm-notes     更新工作区备注
 *   /swarm-list      列出可见工作区
 * MCP 调用协议与 register.mjs/heartbeat.ts 同款（每次独立 initialize）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { loadConfig, type SwarmConfig } from "./config.ts"
import { readWorkspaceId, writeWorkspaceId, workspaceFilePath } from "./workspace.ts"

interface McpResult {
  ok: boolean
  text: string
  /** content[0].text 解析出的对象（工具返回 JSON 时）；非 JSON 时 undefined */
  data?: any
}

function mcpClient(cfg: SwarmConfig) {
  const base = cfg.serverUrl.replace(/\/+$/, "")
  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  })
  return {
    async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
      // 每请求 8s 超时：命令 handler 挂住会卡死 UI（Electron 环境代理劫持 localhost 等场景）
      const timeout = (ms: number) => {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), ms)
        return { signal: ctl.signal, done: () => clearTimeout(timer) }
      }
      try {
        const t1 = timeout(8_000)
        const init = await fetch(`${base}/mcp/`, {
          method: "POST",
          headers: headers(),
          signal: t1.signal,
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dsh-agent-swarm", version: "0.1.0" } },
          }),
        })
        t1.done()
        if (init.status === 401) return { ok: false, text: "apikey 无效（401），请在 web 账号页重新获取并更新配置" }
        if (!init.ok) return { ok: false, text: `服务端连接失败（HTTP ${init.status}）` }
        const t2 = timeout(8_000)
        const r = await fetch(`${base}/mcp/`, {
          method: "POST",
          headers: headers(),
          signal: t2.signal,
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
        })
        const body: any = await r.json()
        t2.done()
        if (!r.ok) return { ok: false, text: `tools/call ${name} 失败（HTTP ${r.status}）` }
        if (body.error) return { ok: false, text: JSON.stringify(body.error) }
        const result = body.result
        if (result?.isError) return { ok: false, text: String(result?.content?.[0]?.text ?? "tool error") }
        const sc = result?.structuredContent
        const textOnly = (result?.content ?? []).map((c: any) => c.text).join("\n")
        // content[0].text 常是 JSON 字符串（服务端工具的返回）——解析成对象随行，
        // 调用方优先用 data，避免二次 stringify/parse 的引号地狱
        let data: any
        try { data = JSON.parse(textOnly) } catch { /* 非 JSON 文本 */ }
        return { ok: true, text: sc !== undefined ? JSON.stringify(sc) : textOnly, data: data ?? sc }
      } catch (e) {
        const msg = String((e as Error)?.cause ?? e)
        return { ok: false, text: msg.includes("abort") ? "服务端响应超时（8s）——检查 agent_swarm 服务是否在线" : `连接失败: ${msg}` }
      }
    },
  }
}

function workspaceIdOrError(directory: string): { id: string } | { error: string } {
  const id = readWorkspaceId(directory)
  if (!id) return { error: "当前目录未注册为工作区（先跑 /swarm-add）" }
  return { id }
}

/** 写 workspace.md 的 WORKSPACE_ID 行（注册/注销用） */
function writeWorkspaceIdFile(directory: string, id: string): void {
  writeWorkspaceId(directory, id)
}

/** 命令目标目录：优先会话工作区（invocation.agent.session.header.cwd，用户在哪个
 * 项目里敲的命令就是哪个项目）；取不到回退插件 cwd。 */
function invocationDir(invocation: any, fallback: string): string {
  const cwd = invocation?.agent?.session?.header?.cwd
  return typeof cwd === "string" && cwd ? cwd : fallback
}

export function swarmCommands(ctx: any, opts: { directory: string; log: (msg: string) => void }): void {
  const { directory, log } = opts
  const commands = ctx.commands
  if (!commands?.register) {
    log("commands service unavailable; /swarm-* disabled")
    return
  }

  const register = (name: string, description: string, run: (rawInput: string, invocation: any) => Promise<{ kind: string; text?: string }>) => {
    try {
      commands.register({
        name,
        description,
        handler: async (invocation: any) => {
          try {
            return await run(String(invocation?.rawInput ?? ""), invocation)
          } catch (e) {
            return { kind: "error", text: String(e) }
          }
        },
      })
      log(`command /${name} registered`)
    } catch (e) {
      log(`command /${name} register failed: ${e}`)
    }
  }

  // /swarm-add —— 注册当前项目（会话工作区）
  register("swarm-add", "把当前项目注册到 agent_swarm 中枢", async (rawInput, invocation) => {
    const cfg = loadConfig()
    if (!cfg) return { kind: "error", text: "插件未配置（缺 ~/.config/dsh/agent-swarm.json），请先运行安装脚本" }
    const directory = invocationDir(invocation, opts.directory)
    const purpose = rawInput.trim()
    const existing = readWorkspaceId(directory)
    if (existing) return { kind: "success", text: `当前目录已是工作区：${existing}（${workspaceFilePath(directory)}）` }
    const client = mcpClient(cfg)
    let purposeText = purpose
    if (!purposeText) {
      const agentsFile = join(directory, "AGENTS.md")
      if (existsSync(agentsFile)) {
        try {
          const first = readFileSync(agentsFile, "utf-8").split("\n").find((l) => l.startsWith("# "))
          if (first) purposeText = first.replace(/^#\s*/, "").slice(0, 120)
        } catch { /* ignore */ }
      }
    }
    const rsp = await client.callTool("workspace_add", {
      path: directory.replace(/\\/g, "/"),
      purpose: purposeText,
      name: basename(directory),
    })
    if (!rsp.ok) return { kind: "error", text: rsp.text }
    const id = String(rsp.data?.workspace_id ?? "")
    if (!id) return { kind: "error", text: `注册返回无 workspace_id: ${rsp.text.slice(0, 300)}` }
    writeWorkspaceIdFile(directory, id)
    // need_summary=true：让当前会话的 agent 分析项目并调 update_info 回填用途/能力
    // （agent 会话里已挂载 mcp__agent-swarm__* 工具）。命令先返回成功提示，分析在后台跑。
    const agent = invocation?.agent
    if (rsp.data?.need_summary && typeof agent?.followup === "function") {
      try {
        agent.followup({
          role: "user",
          content: [{ type: "text", text: `本项目刚注册到 agent_swarm（工作区 ID: ${id}）。请快速浏览项目结构和 README/AGENTS.md，然后调用 mcp__agent-swarm__update_info 工具，purpose 填一句话说明这个项目/工作区是干什么的，capabilities 填它能帮别的 agent 做什么（逗号分隔）。保持简短，不要做其它事。` }],
          source: { kind: "user" },
        })
      } catch (e) {
        log(`/swarm-add followup failed: ${e}`)
      }
    }
    return { kind: "success", text: `✅ 已注册工作区 ${id}（${directory}）${rsp.data?.need_summary ? "\n已让 agent 分析项目，稍后自动回填用途/能力。" : ""}\n${workspaceFilePath(directory)}` }
  })

  // /swarm-remove —— 注销（仅离线可删）
  register("swarm-remove", "从中枢注销当前工作区", async (_rawInput, invocation) => {
    const directory = invocationDir(invocation, opts.directory)
    const cfg = loadConfig()
    if (!cfg) return { kind: "error", text: "插件未配置" }
    const wid = workspaceIdOrError(directory)
    if ("error" in wid) return { kind: "error", text: wid.error }
    // 先下线再删（服务端要求离线可删）
    const client = mcpClient(cfg)
    await client.callTool("workspace_offline", { workspace_id: wid.id })
    const rsp = await client.callTool("workspace_remove", { workspace_id: wid.id })
    if (!rsp.ok) return { kind: "error", text: rsp.text }
    writeWorkspaceIdFile(directory, "")
    return { kind: "success", text: `✅ 已注销工作区 ${wid.id}` }
  })

  // /swarm-enable / /swarm-disable
  const toggle = (name: string, tool: "workspace_enable" | "workspace_disable", label: string) =>
    register(name, `${label}当前工作区`, async (_rawInput, invocation) => {
      const directory = invocationDir(invocation, opts.directory)
      const cfg = loadConfig()
      if (!cfg) return { kind: "error", text: "插件未配置" }
      const wid = workspaceIdOrError(directory)
      if ("error" in wid) return { kind: "error", text: wid.error }
      const rsp = await mcpClient(cfg).callTool(tool, { workspace_id: wid.id })
      return rsp.ok
        ? { kind: "success", text: `✅ ${label}成功：${wid.id}` }
        : { kind: "error", text: rsp.text }
    })
  toggle("swarm-enable", "workspace_enable", "启用")
  toggle("swarm-disable", "workspace_disable", "禁用")

  // /swarm-notes —— 更新备注
  register("swarm-notes", "更新当前工作区备注", async (rawInput, invocation) => {
    const directory = invocationDir(invocation, opts.directory)
    const cfg = loadConfig()
    if (!cfg) return { kind: "error", text: "插件未配置" }
    const notes = rawInput.trim()
    if (!notes) return { kind: "error", text: "用法：/swarm-notes <备注内容>" }
    const wid = workspaceIdOrError(directory)
    if ("error" in wid) return { kind: "error", text: wid.error }
    const rsp = await mcpClient(cfg).callTool("update_notes", { workspace_id: wid.id, notes })
    return rsp.ok
      ? { kind: "success", text: "✅ 备注已更新" }
      : { kind: "error", text: rsp.text }
  })

  // /swarm-list —— 列出可见工作区
  register("swarm-list", "列出中枢上可见的工作区", async () => {
    const cfg = loadConfig()
    if (!cfg) return { kind: "error", text: "插件未配置" }
    const rsp = await mcpClient(cfg).callTool("list_workspaces", {})
    if (!rsp.ok) return { kind: "error", text: rsp.text }
    try {
      const data = JSON.parse(rsp.text)
      const items: any[] = Array.isArray(data) ? data : (data.workspaces ?? [])
      if (items.length === 0) return { kind: "success", text: "（无可见工作区）" }
      const lines = items.map((w) => {
        const online = w.status === "online" ? "🟢" : w.status === "disabled" ? "⛔" : "⚪"
        return `${online} ${w.name ?? w.id} (${w.id})${w.agent_type ? ` [${w.agent_type}]` : ""}`
      })
      return { kind: "success", text: lines.join("\n") }
    } catch {
      return { kind: "success", text: rsp.text }
    }
  })
}
