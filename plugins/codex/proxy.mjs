import { request } from "node:http"
import { Duplex } from "node:stream"
import { AppServer, launchCodex } from "./app-server.mjs"

// 官方 Proxy 在 stdio 上转发原始 WebSocket 字节。HTTP Upgrade 和帧解析交给 Node，
// dispatcher 只接管传输，localhost 是握手的 Host，实际 I/O 只走子进程管道。
export async function openProxy(cwd) {
  const child = launchCodex(["app-server", "proxy"], { cwd })
  const pipe = Duplex.from({ readable: child.stdout, writable: child.stdin })
  let handshakeError
  const dispatcher = {
    dispatch(options, handler) {
      let upgrade
      try {
        const headers = Array.isArray(options.headers) ? options.headers : Object.entries(options.headers).flat()
        upgrade = request({
          host: "localhost", method: options.method, path: options.path,
          headers: [...headers, "Host", "localhost", "Connection", "Upgrade", "Upgrade", "websocket"],
          createConnection: () => pipe,
        })
      } catch (error) {
        handshakeError = error
        throw error
      }
      handler.onConnect(reason => upgrade.destroy(reason))
      upgrade.on("upgrade", (response, socket, head) => {
        if (head.length) socket.unshift(head)
        handler.onUpgrade(response.statusCode, response.rawHeaders.map(header => Buffer.from(header)), socket)
      })
      upgrade.on("response", response => {
        response.resume()
        upgrade.destroy(new Error(`Codex Proxy 握手返回 HTTP ${response.statusCode}`))
      })
      upgrade.on("error", error => {
        handshakeError = error
        handler.onError(error)
      })
      upgrade.end()
      return true
    },
  }
  const socket = new WebSocket("ws://localhost/", { dispatcher })
  const app = new AppServer(child, socket)
  try {
    await new Promise((resolve, reject) => {
      const fail = error => {
        const detail = app.stderr.trim() || handshakeError?.message || error?.message || "握手超时"
        const hint = process.platform === "win32"
          ? "请在普通（非管理员）终端用 codex 打开目标会话，并在同一用户下绑定。"
          : "请确认目标会话使用 Codex 默认共享 App Server。"
        reject(new Error(`无法连接 Codex 默认共享 App Server。${hint}\n${detail}`))
      }
      const timeout = setTimeout(fail, 5000)
      const finish = callback => event => {
        clearTimeout(timeout)
        callback(event?.error ?? event)
      }
      socket.addEventListener("open", finish(resolve), { once: true })
      socket.addEventListener("error", finish(fail), { once: true })
      app.once("closed", finish(fail))
    })
    await app.initialize(true)
    return app
  } catch (error) {
    await app.close()
    throw error
  }
}
