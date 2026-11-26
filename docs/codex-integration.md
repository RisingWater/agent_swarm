# Codex 适配器

安装后仍运行 `codex`。用 `/mcp` 查看 `agent-swarm`，从 `/skills` 选择 `swarm-add` 或在对话里输入 `$swarm-add` 注册当前目录。派单时用该工作区 ID 作为 `from_workspace`。长任务可先用 `wait_seconds=0` 取得任务 ID，再通过 `a2a_task` 查询结果。

## 安装和卸载

需要 Node.js 22+、Codex CLI 0.170+ 和已部署本版本的 Swarm 服务。本次在 Windows npm 安装的 0.172.0 上验证。只安装 Codex 时使用现有分发器的筛选参数。

```powershell
& ([scriptblock]::Create((irm https://<server>/download/install.ps1))) -ApiKey <your-key> -Only codex
```

```bash
curl -fsSL https://<server>/download/install.sh | bash -s -- --api-key <your-key> --only codex
```

安装用官方 `codex mcp add` 写入一个 stdio MCP 入口，并在 `$CODEX_HOME/skills` 安装快捷技能。已有同名技能和用户修改过的技能会保留。其余 Codex 配置和登录由 Codex 管理。同名 MCP 已由用户配置时，安装会保留原配置并报错。适配器只用 Swarm API Key 访问中心，密钥保存在当前用户的 `$CODEX_HOME/agent-swarm/codex/swarm.json`，POSIX 文件权限为 `0600`，Windows 继承用户目录 ACL。未设置 `CODEX_HOME` 时使用 `~/.codex`。

卸载前结束已启动的后台 worker。使用安装路径下的 `install.mjs` 移除 MCP 入口、程序文件和由安装器管理的技能。工作区、调用记录及仅保存任务 ID 哈希和状态的本地去重记录会保留。

```powershell
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
node (Join-Path $codexDir "agent-swarm/codex/install.mjs") --uninstall
```

```bash
node "${CODEX_HOME:-$HOME/.codex}/agent-swarm/codex/install.mjs" --uninstall
```

## 会话快捷入口

| 在 Codex 中输入 | 功能 |
| --- | --- |
| `$swarm-add`、`$swarm-register` | 注册当前目录并保存工作区 ID |
| `$swarm-add-planner` | 以规划器角色注册当前目录 |
| `$swarm-enable`、`$swarm-disable` | 启用或禁用当前工作区 |
| `$swarm-remove` | 移除当前工作区 |
| `$swarm-list`、`$swarm-notes` | 查看可见工作区，或更新当前工作区备注 |

快捷入口使用 [Codex 原生技能](https://developers.openai.com/codex/skills)。网页的首页、工作区和中枢显示 Codex 标识。中枢的 Codex 状态对应后台 worker。

## 接收任务

需要接收任务时，使用安装完成后打印的 worker 命令，传入工作目录。这个按需运行的后台进程独立于 TUI，可以同时为不同目录运行。中心按现有工作区路径规则注册。若同一路径已归属其他适配器，注册会报错并保留原有工作区。

```powershell
node (Join-Path $codexDir "agent-swarm/codex/worker.mjs") "C:/work/project"
```

```bash
node "${CODEX_HOME:-$HOME/.codex}/agent-swarm/codex/worker.mjs" "/path/to/project"
```

后台 worker 通过现有 `/ws/plugin` 接收任务。单个 worker 串行处理任务，每个任务使用独立的临时 App Server Thread，流式回传可见文本、命令与输出、文件变更路径、MCP 调用和最终答复。任务取消会尝试中断对应 Turn。Swarm WebSocket 断开时会重连并补发有界缓冲中的事件。正常退出时会取消本地任务。强制结束 worker 后，已接单任务可能等待服务端超时。后台执行遵循当前 Codex 配置，收到需要交互的审批或提问时结束任务。由原版 TUI 发起的操作继续使用原有审批界面。

## Windows 可行性验证

| 项目 | 命令或观察 | 实际结果 |
| --- | --- | --- |
| 运行时与协议 | `codex --version`、`codex app-server --help`、`codex app-server generate-ts --experimental --out <临时目录>` | CLI 0.172.0。生成定义包含 Thread 枚举、恢复、排队、Turn 启动和中断，以及结构化事件。 |
| 默认 daemon | `codex app-server daemon version` | 初次探测默认用户控制套接字返回 Windows 10050。在隔离 `CODEX_HOME` 中配置本地模拟模型后，仅运行 `codex` 就自动启动了 0.172.0 daemon。 |
| 官方 Proxy | `codex app-server proxy` → HTTP WebSocket Upgrade → WebSocket 文本帧中的 `initialize` / `initialized` | 隔离 daemon 返回 HTTP 101，随后支持 `thread/loaded/list`、`thread/list`、`thread/read`。未知方法返回 `-32600`，重开 Proxy 可重新握手。直接写 JSONL 会超时，指定不存在的 `--sock` 返回 Windows 10061。 |
| TUI 与 Thread | 原版 TUI `/status` 对照 `thread/loaded/list` 和 `thread/read` | Session ID 一致。首次输入前，该 Thread 已加载但未入历史记录，此时 `thread/resume` 返回 `no rollout found`。首轮完成后，`thread/resume` 成功，并收到另一客户端的用户消息、答复增量与 Turn 终态。 |
| 外部排队 | `codex queue --thread <测试 UUID> --message "[Swarm test] Reply PONG."` | 空闲时原版 TUI 显示指令并自动执行。忙碌时任务进入队列，原 Turn 正常完成，随后在下一 Turn 执行排队指令。 |
| 多 TUI 和退出 | 在两个目录运行 `codex`，然后从第一个 TUI 执行 `/exit` | Proxy 同时发现两个 Thread。第一个 TUI 退出后，其 Thread 仍在 `thread/loaded/list` 中。测试中 TUI Thread 的 `source` 还显示为 `vscode`，无法用该字段识别原版 TUI。 |
| daemon 重启 | 对隔离 daemon 执行 `codex app-server daemon restart`，再重连 Proxy | 握手成功。仍开着的 TUI Thread 出现在已加载列表里，已退出的 Thread 在历史中标为 `notLoaded`。 |
| 独立 App Server | `codex app-server --listen stdio://` | `initialize`、`initialized`、`thread/loaded/list`、`thread/list`、未知方法错误及 `thread/start` 已实测。调用 `turn/start` 后通过本地模拟模型返回流式答复和 `completed`。 |
| 安装 | 隔离 `CODEX_HOME` 中运行安装、重复安装、`codex mcp get agent-swarm --json`、卸载 | 正常创建并移除专用入口。测试使用本地模拟模型与测试 Swarm Key。 |

自动发现当前 TUI 需要可靠的客户端归属和离线信号。上面的退出验证表明已加载 Thread 会在 TUI 断开后保留，直接注册会将无人查看的会话发布为在线。当前 Swarm 适配器提供主动 MCP 调用与独立后台接单。前台自动注册、前台 Monitor 和 Swarm 定向注入仍未实现，原版 TUI 可以由操作者使用已知的测试 Thread ID 手动执行官方 `codex queue`。真实跨客户端工具审批分发及 daemon 重启期间的在途任务恢复尚未验证。

执行 `node --test tests/codex.test.mjs tests/codex_runtime.test.mjs` 可重跑协议模拟和真实 CLI 后台测试。将 `SWARM_CODEX_TEST_PYTHON` 指向已安装项目依赖的 Python 解释器后，同一命令还会启动临时 Swarm 服务并验证派单、MCP 桥接、WS 与最终答复。集成测试使用临时回环端口，生产适配器通过 stdio 与 App Server 通信。

官方实现与协议见 [Codex CLI 0.172.0 Proxy](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/cli/src/app_server_proxy.rs) 和 [App Server 0.172.0 文档](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/app-server/README.md)。
