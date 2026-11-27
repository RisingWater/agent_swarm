import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"

// npm 在 Windows 提供脚本 shim；通过 Node 执行官方入口，无需 shell 转义。
export function codexCommand() {
  if (process.platform !== "win32") return ["codex"]
  for (const dir of (process.env.Path ?? process.env.PATH ?? "").split(";")) {
    if (!dir) continue
    const exe = join(dir, "codex.exe")
    const npm = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js")
    if (existsSync(exe)) return [exe]
    if (existsSync(npm)) {
      const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch]
      try {
        const pkg = createRequire(npm).resolve(`@openai/codex-win32-${process.arch}/package.json`)
        const native = join(dirname(pkg), "vendor", `${arch}-pc-windows-msvc`, "bin", "codex.exe")
        if (existsSync(native)) return [native]
      } catch { /* 老版本 npm 包仍可通过官方 JavaScript 入口启动 */ }
      return [process.execPath, npm]
    }
  }
  return ["codex.exe"]
}

export function launchCodex(args, options = {}) {
  const [bin, ...prefix] = codexCommand()
  return spawn(bin, [...prefix, ...args], { windowsHide: true, ...options })
}

// App Server 使用逐行 JSON-RPC。只有请求 ID 进入等待表，通知走独立通道。
export class AppServer extends EventEmitter {
  #pending = new Map()
  #id = 0
  #closed = false
  #exited
  #closing
  #socket

  constructor(child, socket) {
    super()
    this.child = child
    this.#socket = socket
    this.#exited = new Promise(resolve => child.once("close", resolve))
    this.stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-4000) })
    const receive = line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (!message || this.#closed) return
      if (message.method) {
        this.emit(message.id === undefined ? "notification" : "request", message)
        return
      }
      const pending = this.#pending.get(message.id)
      if (pending) {
        this.#pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message ?? "App Server RPC error"))
        else pending.resolve(message.result)
      }
    }
    if (socket) {
      socket.addEventListener("message", event => receive(event.data))
      socket.addEventListener("close", () => this.#finish(new Error("Codex Proxy WebSocket 已断开")))
    } else {
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", receive)
    }
    child.stdin.on("error", error => this.#finish(error))
    child.on("error", error => this.#finish(error))
    child.on("close", (code, signal) => this.#finish(new Error(`App Server 已退出 (${code ?? signal})`)))
  }

  #finish(error) {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    this.emit("closed", error)
  }

  send(message) {
    if (this.#closed || !this.child.stdin.writable) throw new Error("App Server 连接已关闭")
    const json = JSON.stringify(message)
    if (this.#socket) this.#socket.send(json)
    else this.child.stdin.write(json + "\n")
  }

  call(method, params, timeout = 15_000) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`App Server 请求超时 (${method})`))
      }, timeout)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  async initialize(experimentalApi = false) {
    await this.call("initialize", {
      clientInfo: { name: "agent_swarm", title: "Agent Swarm", version: "0.1.0" },
      capabilities: { experimentalApi },
    })
    this.send({ method: "initialized" })
  }

  close() {
    if (this.#closing) return this.#closing
    this.#finish(new Error("App Server 连接已关闭"))
    this.#socket?.close()
    this.child.stdin.end()
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
    }, 2000)
    timer.unref()
    this.#closing = this.#exited.finally(() => clearTimeout(timer))
    return this.#closing
  }
}
