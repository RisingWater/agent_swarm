/** 目录用途总结：调用 LLM（opencode 已配置的模型）生成 purpose/capabilities */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"

const IGNORE = new Set([
  "node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build",
  ".next", "target", ".idea", ".vscode", ".pytest_cache", ".mypy_cache",
])

/** 收集目录上下文：顶层条目 + README/配置文件摘要（限长） */
export function gatherContext(dir: string): string {
  const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []
  const top = entries
    .filter((e) => !IGNORE.has(e.name) && !e.name.startsWith("."))
    .slice(0, 60)
    .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
  const snippets: string[] = []
  for (const f of ["README.md", "readme.md", "package.json", "pyproject.toml", "go.mod", "Cargo.toml"]) {
    const p = join(dir, f)
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8").slice(0, 1500)
        snippets.push(`--- ${f} ---\n${raw}`)
      } catch {}
    }
  }
  return `目录名: ${basename(dir)}\n顶层条目: ${top.join(" ")}\n\n${snippets.join("\n\n")}`.slice(0, 6000)
}

export interface DirSummary {
  purpose: string
  capabilities: string
}

const PROMPT = `你是一个项目分析助手。根据下面提供的工作目录信息，输出两行内容（不要输出其他任何内容）：

PURPOSE: 一句话总结这个目录是干什么的项目/用途（不超过80字，中文）
CAPABILITIES: 这个工作区的 agent 可以帮助做什么（不超过80字，中文，如"修改前端组件、调试构建问题、写文档"）

目录信息：
`

/** 调 opencode 本地 server 的 /session 接口让 LLM 总结目录（一次性成本，注册时调用一次） */
export async function summarizeWithLLM(
  client: any,
  dir: string,
  timeoutMs = 60_000,
): Promise<DirSummary> {
  const context = gatherContext(dir)
  const fallback: DirSummary = {
    purpose: `工作目录 ${basename(dir)}`,
    capabilities: "浏览与编辑代码、解释实现细节、修改 bug",
  }

  try {
    const created = await client.session.create({ body: { title: `swarm-register-${basename(dir)}` } })
    const sessionId: string = (created as any)?.data?.id ?? created?.id
    if (!sessionId) return fallback

    const promptRsp = await Promise.race([
      client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: PROMPT + context }],
          tools: { edit: false, write: false, bash: false, patch: false },
        },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("summary timeout")), timeoutMs)),
    ])

    // 提取 assistant 文本回复
    let text = ""
    const rsp: any = promptRsp as any
    const data = rsp?.data ?? rsp
    const parts = data?.parts ?? data?.info?.parts ?? []
    for (const p of parts) {
      if (p?.type === "text" && typeof p.text === "string") text += p.text
    }
    if (!text) {
      // 兜底：直接拉会话消息
      const msgs: any = await client.session.messages({ path: { id: sessionId } })
      const arr = msgs?.data ?? msgs ?? []
      const last = Array.isArray(arr) ? arr[arr.length - 1] : null
      const lp: any[] = last?.info?.parts ?? last?.parts ?? []
      for (const p of lp) if (p?.type === "text") text += p.text ?? ""
    }

    const purpose = text.match(/PURPOSE:\s*(.+)/i)?.[1]?.trim()
    const capabilities = text.match(/CAPABILITIES:\s*(.+)/i)?.[1]?.trim()
    return {
      purpose: purpose || fallback.purpose,
      capabilities: capabilities || fallback.capabilities,
    }
  } catch {
    return fallback
  }
}
