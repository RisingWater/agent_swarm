/** agent_swarm TUI 插件：/swarm-* 原生命令（弹窗交互，零 token，替代 md 命令）。
 *
 * 模块形态 {id, tui}（TUI 渲染层插件），与 server 端插件（default export）同目录部署，
 * opencode.jsonc 的 plugin 数组分别注册两个文件。
 *
 * 命令：
 *   /swarm-mode     弹窗选择 foreground / background
 *   /swarm-add      md 命令（commands/swarm-add.md，前台会话由 agent 生成 purpose 后调
 *                   MCP workspace_add/update_info），不在此处注册
 *   /swarm-remove   自动删除工作区（仅离线可删）→ 清 WORKSPACE_ID（不弹窗）
 *   /swarm-enable   自动启用
 *   /swarm-disable  自动禁用
 *
 * server 地址与 apikey 读 ~/.config/opencode/agent-swarm.json（与 server 插件共用配置）；
 * workspace ID 读/写项目根（api.state.path.worktree）的 .agent-swarm.md。
 */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"

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

/** 追加到插件日志（与 server 插件共用 plugin.log），便于排查 */
function tuiLog(msg: string) {
  try {
    const fs = loader()!
    const home = process.env.HOME || process.env.USERPROFILE || ""
    const logf = `${home}/.config/opencode/plugins/agent-swarm/plugin.log`
    fs.appendFileSync(logf, `${new Date().toISOString()} [tui] ${msg}\n`)
  } catch {
    /* 日志失败不致命 */
  }
}

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

const MODE_LABEL: Record<string, string> = {
  foreground: "前台（注入当前 TUI 会话）",
  background: "后台（独立 headless 进程执行）",
}

const tui: TuiPlugin = async (api) => {
  const worktree = api.state.path.worktree
  const file = swarmFile(worktree)

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