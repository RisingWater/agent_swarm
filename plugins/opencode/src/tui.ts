/** agent_swarm TUI 插件：/swarm-* 原生命令（弹窗交互，零 token，替代 md 命令）。
 *
 * 模块形态 {id, tui}（TUI 渲染层插件），与 server 端插件（default export）同目录部署，
 * opencode.jsonc 的 plugin 数组分别注册两个文件。
 *
 * 命令：
 *   /swarm-mode     弹窗选择 foreground / background
 *   /swarm-add      自动注册当前目录 → 写 .agent-swarm.md；随后 spawn headless opencode
 *                   （挂载当前会话）总结项目用途并回传
 *   /swarm-remove   自动删除工作区（仅离线可删）→ 清 WORKSPACE_ID（不弹窗）
 *   /swarm-enable   自动启用
 *   /swarm-disable  自动禁用
 *
 * server 地址与 apikey 读 ~/.config/opencode/agent-swarm.json（与 server 插件共用配置）；
 * workspace ID 读/写项目根（api.state.path.worktree）的 .agent-swarm.md。
 */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { spawn } from "node:child_process"

const CFG_PATH = (() => {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const dataHome = process.env.XDG_CONFIG_HOME
  if (dataHome) return `${dataHome.replace(/[\\/]+$/, "")}/opencode/agent-swarm.json`
  return `${home}/.config/opencode/agent-swarm.json`
})()

interface SwarmCfg {
  serverUrl?: string
  apiKey?: string
  executionMode?: string
  backgroundCommand?: string
}

const loader = () => process.getBuiltinModule?.("node:fs")

function readCfg(): SwarmCfg {
  try {
    return JSON.parse(loader()!.readFileSync(CFG_PATH, "utf8"))
  } catch {
    return {}
  }
}

function writeCfg(cfg: SwarmCfg): boolean {
  try {
    loader()!.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + "\n")
    return true
  } catch {
    return false
  }
}

async function swarmApi<T>(path: string, method = "GET", body?: unknown): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const cfg = readCfg()
  const base = (cfg.serverUrl ?? "").replace(/\/+$/, "")
  if (!base || !cfg.apiKey) return { ok: false, status: 0, data: null, error: "插件未配置（缺 agent-swarm.json）" }
  try {
    const rsp = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = (await rsp.json().catch(() => null)) as T | null
    if (!rsp.ok) {
      const detail = (data as any)?.detail ?? `HTTP ${rsp.status}`
      return { ok: false, status: rsp.status, data, error: String(detail) }
    }
    return { ok: true, status: rsp.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) }
  }
}

/** 项目根的 .agent-swarm.md 读写 */
function swarmFile(worktree: string) {
  const path = `${worktree.replace(/[\\/]+$/, "")}/.agent-swarm.md`
  const fs = loader()!
  const read = (): string => {
    try {
      return fs.readFileSync(path, "utf8")
    } catch {
      return ""
    }
  }
  /** 文件不存在则按模板创建（WORKSPACE_ID/PURPOSE/CAPABILITIES 占位行） */
  const ensure = (workspaceId: string) => {
    if (read() === "") {
      fs.writeFileSync(
        path,
        `# agent_swarm\n\nPURPOSE: \nCAPABILITIES: \nWORKSPACE_ID: ${workspaceId}\n`,
        "utf-8",
      )
    }
  }
  const setLine = (key: string, value: string | null) => {
    let text = read()
    if (text === "") {
      // 文件不存在：先按模板建（ID 稍后由调用方传入），再在末尾加行
      ensure("")
      text = read()
    }
    const re = new RegExp(`^${key}:.*$`, "m")
    if (value === null) {
      text = text.replace(new RegExp(`^${key}:.*\\n?`, "m"), "")
    } else if (re.test(text)) {
      text = text.replace(re, `${key}: ${value}`)
    } else {
      text = text.replace(/\s*$/, "") + `\n${key}: ${value}\n`
    }
    fs.writeFileSync(path, text)
  }
  const getLine = (key: string): string => {
    const m = read().match(new RegExp(`^${key}:\\s*(.*)$`, "m"))
    return m?.[1]?.trim() ?? ""
  }
  return { path, read, setLine, getLine, ensure }
}

/** 拉起 headless opencode（挂载当前会话）总结项目用途，返回总结文本。30s 超时。 */
function summarizePurpose(worktree: string, currentSessionId: string, timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    const bin = process.env.OPENCODE_BIN || "opencode"
    const prompt = [
      "请快速浏览当前工作区的代码与文档（README/AGENTS.md/package.json 等）。",
      "用一句简短中文概括这个项目的用途（是什么、用于什么场景）。",
      "只输出这一句概括，不要输出任何其他内容。",
    ].join("\n")
    const args = ["run", prompt, "--format", "json", "--auto", "--title", "swarm-purpose"]
    if (currentSessionId) args.push("--session", currentSessionId)

    let proc
    try {
      proc = spawn(bin, args, { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      resolve(null)
      return
    }

    let buf = ""
    let lastText = ""
    let settled = false
    const settle = (res: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(res)
    }
    const timer = setTimeout(() => {
      if (proc.pid) {
        try { process.kill(-proc.pid, "SIGKILL") } catch { proc.kill("SIGKILL") }
      }
      settle(lastText || null)
    }, timeoutMs)

    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      let idx: number
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const evt = JSON.parse(line)
          const part = evt.part ?? {}
          if (part.type === "text" && !part.synthetic && typeof part.text === "string" && part.text.trim()) {
            lastText = part.text.trim()
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    })
    proc.stderr!.on("data", () => { /* 忽略 stderr */ })
    proc.on("error", () => settle(lastText || null))
    proc.on("close", () => settle(lastText || null))
  })
}

const MODE_LABEL: Record<string, string> = {
  foreground: "前台（注入当前 TUI 会话）",
  background: "后台（独立 headless 进程执行）",
}

const tui: TuiPlugin = async (api) => {
  const worktree = api.state.path.worktree
  const file = swarmFile(worktree)
  const currentSessionId =
    api.route.current.name === "session"
      ? String((api.route.current as any).params?.sessionID ?? "")
      : ""

  const toastErr = (e: string) => api.ui.toast({ variant: "error", message: e, duration: 6000 })

  if (!api.command) return
  api.command.register(() => [
    {
      title: "Swarm: Execution Mode",
      value: "swarm.mode",
      description: "切换 A2A 任务执行模式（前台/后台）",
      slash: { name: "swarm-mode" },
      onSelect: (dialog) => {
        const cfg = readCfg()
        if (!cfg.serverUrl || !cfg.apiKey) {
          toastErr("agent_swarm 插件未配置，请先运行安装命令")
          return
        }
        dialog?.replace(() =>
          api.ui.DialogSelect({
            title: "任务执行模式",
            options: (Object.keys(MODE_LABEL) as string[]).map((m) => ({
              title: `${cfg.executionMode === m ? "● " : "○ "}${MODE_LABEL[m]}`,
              value: m,
            })),
            get current() {
              return cfg.executionMode ?? "foreground"
            },
            onSelect: (opt) => {
              const next = String(opt.value)
              const updated = { ...readCfg(), executionMode: next }
              if (writeCfg(updated)) {
                api.ui.toast({
                  variant: "success",
                  message: `执行模式: ${MODE_LABEL[next]}（下一个 A2A 任务生效）`,
                  duration: 5000,
                })
              } else {
                toastErr("写入配置失败")
              }
              dialog?.clear()
            },
          }),
        )
      },
    },
    {
      title: "Swarm: Add Workspace",
      value: "swarm.add",
      description: "注册当前目录为 agent_swarm 工作区并总结用途",
      slash: { name: "swarm-add" },
      onSelect: async (dialog) => {
        dialog?.clear()
        const rsp = await swarmApi<{ workspace_id: string; created: boolean; name: string }>("/api/workspaces", "POST", {
          path: worktree,
        })
        if (!rsp.ok || !rsp.data) {
          toastErr(`注册失败: ${rsp.error}`)
          return
        }
        // 写 .agent-swarm.md：模板创建（PURPOSE/CAPABILITIES/WORKSPACE_ID 行）并更新 ID
        file.ensure(rsp.data.workspace_id)
        file.setLine("WORKSPACE_ID", rsp.data.workspace_id)
        api.ui.toast({
          variant: "success",
          message: `已注册 ${rsp.data.workspace_id}，正在总结用途…`,
          duration: 4000,
        })
        // headless opencode 总结项目用途（挂当前会话），成功后上传 server 并写入 .agent-swarm.md
        const purpose = await summarizePurpose(worktree, currentSessionId)
        if (purpose) {
          await swarmApi("/api/workspaces", "POST", { path: worktree, purpose })
          file.setLine("PURPOSE", purpose)
          api.ui.toast({
            variant: "success",
            message: `用途已更新: ${purpose.slice(0, 60)}${purpose.length > 60 ? "…" : ""}`,
            duration: 6000,
          })
        } else {
          api.ui.toast({
            variant: "info",
            message: "用途总结未生成（进程无输出/超时），可后续用 /swarm-note 补充",
            duration: 5000,
          })
        }
      },
    },
    {
      title: "Swarm: Remove Workspace",
      value: "swarm.remove",
      description: "删除本目录注册的工作区（仅离线可删）",
      slash: { name: "swarm-remove" },
      onSelect: async (dialog) => {
        dialog?.clear()
        const wid = file.getLine("WORKSPACE_ID")
        if (!wid) {
          toastErr(".agent-swarm.md 没有 WORKSPACE_ID（本目录未注册）")
          return
        }
        const rsp = await swarmApi(`/api/workspaces/${wid}`, "DELETE")
        if (rsp.status === 409) {
          toastErr("工作区在线/最近心跳，不能删除——先停掉本目录的 opencode 再试")
          return
        }
        if (!rsp.ok) {
          toastErr(`删除失败: ${rsp.error}`)
          return
        }
        file.setLine("WORKSPACE_ID", null)
        api.ui.toast({ variant: "success", message: `已删除 ${wid}` })
      },
    },
    {
      title: "Swarm: Disable Workspace",
      value: "swarm.disable",
      description: "禁用工作区（不参与任务接收）",
      slash: { name: "swarm-disable" },
      onSelect: async (dialog) => {
        dialog?.clear()
        const wid = file.getLine("WORKSPACE_ID")
        if (!wid) {
          toastErr(".agent-swarm.md 没有 WORKSPACE_ID")
          return
        }
        const rsp = await swarmApi(`/api/workspaces/${wid}/disable`, "POST")
        if (rsp.ok) api.ui.toast({ variant: "success", message: "已禁用" })
        else toastErr(`禁用失败: ${rsp.error}`)
      },
    },
    {
      title: "Swarm: Enable Workspace",
      value: "swarm.enable",
      description: "启用工作区",
      slash: { name: "swarm-enable" },
      onSelect: async (dialog) => {
        dialog?.clear()
        const wid = file.getLine("WORKSPACE_ID")
        if (!wid) {
          toastErr(".agent-swarm.md 没有 WORKSPACE_ID")
          return
        }
        const rsp = await swarmApi(`/api/workspaces/${wid}/enable`, "POST")
        if (rsp.ok) api.ui.toast({ variant: "success", message: "已启用，等插件心跳上线" })
        else toastErr(`启用失败: ${rsp.error}`)
      },
    },
  ])
}

export default {
  id: "agent-swarm-tui",
  tui,
}