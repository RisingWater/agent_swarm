import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { AppServer, launchCodex } from "./app-server.mjs"
import { openProxy } from "./proxy.mjs"

function bindingPath(cwd) {
  return join(cwd, ".agent_swarm", "codex-thread")
}

export function foregroundThread(cwd) {
  try {
    return readFileSync(bindingPath(cwd), "utf8").trim() || undefined
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

export async function openForeground(cwd, launch = launchCodex, connect = openProxy) {
  try {
    return { app: await connect(cwd), readHistory: false }
  } catch (proxyError) {
    // 内置 App Server 没有可连接的 socket。官方独立 App Server 可以提交到同一 Codex Home 的持久队列。
    const app = new AppServer(launch(["app-server", "--listen", "stdio://"], { cwd }))
    try {
      await app.initialize(true)
      return { app, readHistory: true }
    } catch (error) {
      await app.close()
      throw new Error(`Codex 前台连接失败：${proxyError.message}\n独立 App Server：${error.message}`)
    }
  }
}

export async function prepareForegroundThread(app, threadId, cwd, readHistory) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error("请使用 Codex /status 中的 Session ID")
  }
  if (!readHistory) {
    const { data } = await app.call("thread/loaded/list", {})
    if (!data.includes(threadId)) throw new Error("绑定的 Codex 会话未加载，请打开该会话或重新绑定")
  }
  const { thread } = await app.call("thread/read", { threadId, includeTurns: false })
  const normalize = directory => {
    const path = realpathSync(directory)
    return process.platform === "win32" ? path.toLowerCase() : path
  }
  if (normalize(thread.cwd) !== normalize(cwd)) {
    throw new Error("绑定的 Codex 会话不在当前工作目录")
  }
  if (readHistory) {
    if (thread.ephemeral) throw new Error("临时 Codex 会话没有可读取的历史记录")
    await app.call("thread/turns/list", { threadId, limit: 1 })
  } else {
    if (thread.status?.type === "notLoaded") throw new Error("绑定的 Codex 会话未加载，请打开该会话或重新绑定")
    // 先确认可以订阅。新开且从未运行的会话没有可恢复的历史。
    await app.call("thread/resume", { threadId, excludeTurns: true })
  }
}

export async function bindForegroundThread(cwd, threadId) {
  const { app, readHistory } = await openForeground(cwd)
  try {
    await prepareForegroundThread(app, threadId, cwd, readHistory)
    const file = bindingPath(cwd)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, threadId + "\n", { mode: 0o600 })
  } finally {
    await app.close()
  }
}

export function clearForegroundThread(cwd) {
  rmSync(bindingPath(cwd), { force: true })
}
