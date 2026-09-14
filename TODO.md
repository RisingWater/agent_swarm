# agent_swarm 开发进度 TODO

> 更新时间: 2026-09-14 深夜2 · Windows 机（D:\wangxu\work\agent_swarm，workspace ID 4g8rHi43MHaWurH9XYsGNH）
> 服务已跑在 :8700（.\deploy\start.ps1 前台运行）· 前端构建产物由 8700 静态托管
> claude 后台会话骨架已写完并提交（见已完成第 1 节），**简单测试发现多个问题未解决** → 接手先看待办第 0 条

## 项目一句话

多 agent 协作平台（虫群）：FastAPI 单服务（管理 API + MCP 端点 + A2A 网关 + 插件分发）+ 多 agent 插件（plugins/ 下 opencode / claude）+ 纯 React 前端。面向 agent 的操作全部走服务端 MCP 工具；工作区互调 / web 中枢 / 外部 agent 统一走 A2A 协议（`server/nexus_a2a.py` 手写子集）；插件负责心跳保活 + A2A 任务接收执行。

## 架构演进史（历次用户拍板，读懂再动手）

- **2026-09-11 v0**：插件注入 8 个 swarm_* 工具 + request_help 求助闭环 + LLM 惰性总结目录
- **2026-09-12 MCP-first（用户拍板）**：**MCP 工具是唯一面向 agent 的接口**，任何 MCP 客户端（claude/deepseek harness/…）直连 /mcp 即用，可移植性优先；插件瘦身为心跳保活；工作区 ID 持久化到项目根 `.agent-swarm.md` 的 `WORKSPACE_ID:` 行（register_workspace/whoami 已删，workspace_add 一个工具覆盖）
- **2026-09-12 workspace_call**：跨 agent 任务派发上线（前台注入优先，后台会话兜底，权限由目标端用户在 TUI 响应）；旧 request_help/poll/submit 双模式设计整体删除
- **2026-09-13 claude 接入**：keepalive.mjs 零依赖 stdio MCP 保活
- **2026-09-14 A2A 化（替换 workspace_call + nexus 自定义协议）**：统一走 A2A 0.3.x 子集（手写，无官方 SDK）
- **2026-09-14 后台会话（用户拍板）**：后台会话必须在独立会话执行（复用前台会话会上下文互串）；同一来源（caller）的任务归组到同一后台会话（映射表 `.agent-swarm-sessions.json`，键=caller）；opencode 后台 spawn 加 `--pure`（不加载插件）+ `--thinking`（reasoning 流）
- **2026-09-14 claude 只做后台（用户拍板）**：claude 无前台注入，全部任务走 headless `claude -p` 后台执行；keepalive 进程兼任 A2A 任务接收
- **2026-09-14 /swarm-* 命令 TUI 化**：md 命令 → 原生 TUI 命令（tui.ts）；后 /swarm-add 因 headless 总结方案废弃**回退 md 命令**，其余 4 个保持 TUI
- ~~**headless spawn opencode 生成 purpose**~~（2026-09-14 已废弃）：挂 `--session 当前会话` 把对话上下文带进总结上传过屁话；专属 summarySessionId 复用会话方案复杂度又高，写了又删。purpose 回归前台 agent 自己分析（md 命令流程）
- ~~teams 团队功能~~（API/前端已删，**表保留**，用户"想好后再加"）
- ~~request_help 求助体系~~（被 workspace_call 替代后整体删除，help_requests 表已 DROP）
- ~~workspace_call 自定义协议~~（被 A2A 替代，workspace_calls 表已 DROP，改 a2a_tasks）
- ~~视频走 git lfs~~（放弃：mp4 39MB 普通 blob 已推送成功，用户接受仓库变大）
- ~~e2e 测试脚本~~（用户 2026-09-12 决定放弃，scripts/test_plugin_smoke.ts 是死代码可删可留）

## 已完成（除注明外均已进 git）

### claude 后台会话骨架（2026-09-14 深夜2，已提交，简单测试发现多处问题 → 接手先看待办第 0 条）

- ✅ **`plugins/claude/nexus_a2a.mjs`（新文件，零依赖）**：WS 客户端连 `/ws/plugin`（hello/rpc/event/ping/重连，与 opencode `nexus_a2a.ts` 同构）；A2A 事件构造 statusUpdate/agentMessage/artifactUpdate/toolStatus/streamStatus；DataPart（input-required 应答）直接报错拒绝（claude 后台不支持交互）
- ✅ **`plugins/claude/background.mjs`（新文件，零依赖）**：spawn `claude -p <prompt> --output-format stream-json --include-partial-messages --verbose --dangerously-skip-permissions --max-turns 100`（用户拍板 100 轮）；事件归一化：system/init→session_id、thinking_delta→reasoning、text_delta→text（累积）、content_block_start(tool_use)→toolStatus(running)、user.tool_result→toolStatus(completed/error)、result(is_error)→failed；30min 超时/并发 3/cancel（Windows taskkill /T /F，POSIX 负 PID）；`resolveBin` 解析 Windows 真实 exe（`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`）；resume 被拒（exit≠0 且从未见 session_id，实测 stderr "No conversation found"）自动新会话重试
- ✅ **`keepalive.mjs` 改造**：启动 A2A WS 客户端收任务（与心跳同进程）；来源映射表（`.agent-swarm-sessions.json`，caller→claude session UUID，与 opencode 同格式同文件名）查表 `--resume` 续聊 + 任务结束回写（成功失败都写）
- ✅ **服务端放开 claude 拦截 ×3**：`nexus_a2a.py` a2a_rpc/nexus_send + `mcp_endpoint.py` a2a_call
- ✅ **`install-claude.ps1/.sh`**：拷贝新增 mjs 文件
- ✅ 语法验证过（node --check ×3）；实验验证过 claude -p stream-json 事件形状、--resume 续聊/无效 resume 语义（Windows 机）
- ⚠️ **未 E2E 验证，用户简单测试发现多处问题（见待办第 0 条，日志已留档分析）**

### 后台会话按 caller 续聊 + Windows 适配（2026-09-14 深夜，0a5e46e 已提交推送，E2E 首单已验证）

- ✅ **`plugins/opencode/src/sessions.ts`（新文件）**：后台会话映射表 `.agent-swarm-sessions.json`（工作区根目录，已进 .gitignore），键 = caller（nexus-web / 调用方工作区 ID / 外部 A2A URL），值 = opencode 会话 ID；同一来源的任务复用同一后台会话保证对话连续性，成功失败都回写
- ✅ **background.ts 重构**：拆出 `spawnOnce`（单次 spawn 到退出）+ `runBackgroundTask` 编排；新增 `--pure`（子进程不加载插件，避免同 WORKSPACE_ID 二连顶掉 TUI 的 /ws/plugin 连接）、`--thinking`（stdout 输出 reasoning 事件实时回传 web）；`--session` 被拒（非零退出且无任何 stdout 事件）自动去锚点用新会话重试一次
- ✅ **Windows 适配**：spawn "opencode" 在 Windows 会 ENOENT（npm 全局命令是 .cmd shim）→ `resolveBin` 解析到 `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`；杀进程树 Windows 无进程组语义 → `taskkill /PID <pid> /T /F`（POSIX 仍用负 PID 信号）
- ✅ **E2E 首单已通过**（Windows 机）：nexus-web 下发 → 后台独立会话（ses_f5fb6ecc…，run=f5748d48，前台 TUI 无任务文本）→ 真实执行并回传。之前一单 M9xmrEpK 因 ENOENT 失败，正是 resolveBin 修复的触发点
- ⚠️ Linux 侧注意：`process.kill(-pid)` 负 PID 仅对 detached 进程组有效；resolveBin 只找 Windows 路径，Linux 下仍裸用 "opencode"（PATH 命中）

### /swarm-* 命令：TUI 化 + /swarm-add 回退 md 命令（2026-09-14）

- ✅ **TUI 插件 `plugins/opencode/src/tui.ts`**：`/swarm-mode`（DialogSelect 选前台/后台）、`/swarm-remove`、`/swarm-enable`、`/swarm-disable` 四命令，静默执行 + toast 反馈（用户决策：只有 mode 弹窗）
  - ⚠️ 坑：TUI 插件必须注册在 `~/.config/opencode/tui.jsonc`，**不是** opencode.jsonc（server 插件 {server} 才进 opencode.jsonc）；装错报 "must default export an object with server()"
  - 安装脚本 install-opencode.sh|.ps1 按此拆分注册 + 清理旧 md 命令（swarm-register/note/desc/resummarize 等）
- ✅ **`/swarm-add` 为 md 命令**（`plugins/opencode/commands/swarm-add.md`，不进 tui.ts）：前台会话由 agent 自己分析项目生成 PURPOSE/CAPABILITIES（各≤80字），调 MCP `workspace_add`，`need_summary=true` 时用 `update_info` 回写，再把 WORKSPACE_ID/PURPOSE/CAPABILITIES 三行写入 `.agent-swarm.md`（模板 `# agent_swarm` + 三行）。已实测走通，本仓库 purpose/capabilities 干净
- ✅ **服务端**：`POST /api/workspaces` 注册端点（purpose/capabilities 字段）；`server/auth.py` 加 `get_user_either`（JWT 优先、apikey 兜底）——TUI 插件只有 apikey，REST create/disable/enable/delete 走它
- ✅ `/swarm-mode` 切换即时生效：`executeTask` 每任务 `loadConfig()` 重读执行模式（曾用启动时闭包快照导致切换不生效）
- ✅ **config 合并优先级修正**：全局 `~/.config/opencode/agent-swarm.json` 显式设置时优先（老逻辑"任一来源为 background 就 background"，全局切不回 foreground）
- 用户本机 apikey 曾出现尾部多 `~` 的脏数据（agent-swarm.json），已修；来源未知，再见到先查这里

### 后台执行模式（2026-09-14，骨架完成 + Windows E2E 首单通过）

- ✅ `plugins/opencode/src/background.ts`：spawn `opencode run --format json --auto --title A2A-<id>` headless 进程；stdout JSON 事件流（text/reasoning/tool_use）归一化为 A2A 事件（与前台同通道上报）；exit code + finalText 决定 completed/failed；30min 超时 kill 进程树、并发上限 3、cancel 支持
- ✅ `config.ts` `executionMode`: foreground / background，`backgroundCommand: auto`
- ✅ 修复：后台任务不再携带服务端会话锚点（锚点=心跳上报的当前 TUI 会话，resume 它等于把任务注回前台）——后台会话改为按 caller 映射表路由（见最上一节）

### A2A 协议改造（2026-09-14，替换 nexus 自定义协议 + workspace_call）

- ✅ **服务端 `server/nexus_a2a.py`**（手写 A2A 0.3.x 子集，无官方 SDK）：
  - HTTP 入站：`GET /.well-known/agent-card.json`（中枢卡）+ `GET/POST /a2a/{workspace_id}`（工作区卡 + `message/send`、`message/stream` SSE、`tasks/get`、`tasks/cancel`），apikey 鉴权，对象 camelCase 规范形状
  - WS 内部链路：`/ws/plugin`（rpc 下发/应答 + event 流）、`/ws/nexus`（web 订阅）；离线任务 hello 时补推（不再靠 heartbeat 捎带）
  - 进程内事件总线 `_task_queues`：SSE / 同步等待纯推送无轮询；事件落 `a2a_events`（web 回放上限 800）
  - REST：`POST /api/nexus/{wid}/message:send`（web 下发）、`POST /api/nexus/{wid}/reply`（input-required 应答，转 DataPart 续聊）、`GET/DELETE /api/nexus/{wid}/history`
- ✅ **MCP 工具 13→11**：删 workspace_call/status/ack/result，新增 `a2a_call`（工作区 ID 或外部 URL）+ `a2a_task`；外部任务落同一张 `a2a_tasks` 表（external_url 标记）
- ✅ **插件**：`nexus_a2a.ts`（JSON-RPC 分发 + A2A 事件构造）+ `index.ts` `executeTask`：opencode SSE → `metadata.nexus`（text/reasoning/tool）事件、权限/提问 → `input-required` DataPart、idle → artifact（全量文本 lastChunk）+ completed；input-required 应答走 `onReply` 路由回 opencode API
- ✅ **心跳增强**：heartbeat 新增 `session_title` 参数（workspaces 表加列，db.py 自动迁移），插件会话变化时拉一次标题随心跳上报
- ✅ **web**：中枢页改 A2A 事件渲染（WS 载荷直转 TimelineItem，taskId 随权限/提问条目存储供应答）；调用记录页状态对齐 TaskState（queued/working/completed/failed/canceled）
- ✅ **E2E 已实测**（Linux，:8700）：a2a_call 互调全链路（rpc 下发→事件流→artifact→completed→a2a_task 轮询到结果）、外部 message/send 入站、message/stream SSE（快照→流式进度→artifact→final）、web 中枢 WS 订阅+REST 下发+清空历史，全部通过

### 中枢 nexus（2026-09-12/13）

- ✅ 服务端 WS hub（JWT 鉴权）+ `nexus_events` 持久化（A2A 改造后为 `a2a_events` + `/ws/nexus` 订阅）；指令落调用记录，来源标注 `nexus-web`（预留 feishu/wechat 扩展）
- ✅ 前端「中枢」页：选在线工作区下发指令，时间线实时滚动；权限请求/提问页面点选应答；终端风格 UI；上次选中工作区记 cookie（30 天）

### workspace_call 跨 agent 调用（2026-09-12，已被 A2A 替代下线，链路设计仍可参考）

- ✅ 服务端 pending/running/done/failed 状态机 + heartbeat 捎带任务 + REST `/api/calls`
- ✅ 插件前台注入：event hook 跟踪当前会话、冷启动 session.list 挑最近活跃 + toast 通知、fgBusy 排队（10min 上限）+ session.status busy 检查、idle 残留清理；「前台可见 + 结果回传」全链路实测通过

### claude code 接入（2026-09-13）

- ✅ `plugins/claude/keepalive.mjs` 零依赖 stdio MCP 保活 + install-claude 脚本 + `/swarm-*` 命令
- ✅ 含中文 ps1 必须 UTF-8 with BOM（详见 AGENTS.md）
- ✅ claude 后台会话骨架（2026-09-14 深夜2，见已完成第 1 节，问题见待办第 0 条）

### 服务端 / 前端 / 基建（2026-09-11~12）

- ✅ REST：注册/登录、apikey 明文可见+重置、修改密码（校验原密码）、工作区 CRUD、调用记录列表+删除
- ✅ 11 个 MCP 工具（见 A2A 节）；插件分发 /download/*（tar.gz + install.sh/ps1，Host 动态注入地址）
- ✅ 前端：虫群品牌（logo/favicon，Pillow 生成）、opencode.ai 风格首页（hero/安装块/演示视频 39MB 进视口自动播/特性卡）、登录弹窗化、账号页（API Key | 修改密码）、文档页（6 章纯用户视角）、工作区/调用记录页（markdown 渲染结果、搜索、离线时间 hover tip）
- ✅ docker/ 实测构建通过（agent-swarm:latest 286MB，已推 10.17.17.19:8082）
- ✅ README.md + AGENTS.md（分工：产品文档归 README/文档页，AGENTS 只放架构决策与 gotcha）

## 🟡 未完成 / 待办（接手从这里开始）

### 0. claude 后台会话问题修复（最高优先级，接手先做这个）

骨架已提交但用户简单测试发现多处问题。**keepalive.log 实测异常（2026-09-14T15:49 前后，nas_brain 工作区 CZBLEoPszNwLWpA2J4auGA，cwd=D:\wangxu\Ai\nas_brain）**：

1. **keepalive 多实例互相踢**（最严重）：日志见同一秒内多个 `start: cwd=...` + `nexus a2a ready` / `nexus disconnected, reconnecting` 无限循环。根因：多个 claude 会话/`claude -p` spawn 各自的 keepalive 子进程（MCP 配置是 --scope user，每个 claude 实例都 spawn），且**后台任务自己 spawn 的 `claude -p` 又会 spawn 新的 keepalive**（`claude -p` 默认加载 user-scope MCP！）→ 同一 workspace_id 多个 WS 连接互相顶（服务端 nexus_a2a.py:930 "replaced by new connection"），还伴随 stdin close 退出风暴。**修复方向**：后台 spawn claude 时加 `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`（禁掉 user-scope MCP，与 opencode `--pure` 同思路）；keepalive 侧再考虑启动时锁（如端口/文件锁）或服务端容忍多连（只读心跳无害，但任务分发要幂等）
2. **同一任务被两个实例各执行一次**：日志 `a2a task ZJB2B3UD` 出现两次、spawn 两次（顶号后补推 queued + hello 时 `_flush_queued` 补推叠加）。修掉问题 1 后大概率自愈，但服务端最好加"任务已派发不重推"标记
3. **续聊上下文**：2AMhaTMF 走了 `resume 8db4c0e9-6a8`（映射表生效），但需验证 resume 后对话真的延续（claude session UUID 写入时机 = system/init 行，若任务失败在 init 前会回写空）
4. **web 中枢展示**：claude 后台事件（metadata.agent=claude）是否正常渲染未验证
5. 修完跑完整 E2E：web 中枢给 claude 工作区连发 2 条（验证同 session 续聊 + 中枢实时滚动 thinking/tool/text）+ opencode 工作区 a2a_call claude 工作区 1 条

### 高优先级

- [ ] **后台会话续聊 E2E（opencode 侧）**：同 caller（如 nexus-web）连发两个任务，验证第二个任务复用 `.agent-swarm-sessions.json` 里记录的会话（plugin.log 应见 `resume ses_`），且对话上下文延续
- [ ] **前端 web 的 A2A 与后台会话展示未更新**（用户原话："前端的a2a和后台会话还没有更新"）：后台任务独立会话（A2A-xxx）在中枢页无区分展示；task 的 session_id 上报后工作区表"当前会话"列刷新未验证；后台事件（metadata.background=true）前端未特殊渲染
- [ ] 真实 opencode 前台注入 E2E：web 下发 → TUI 前台注入 → 权限应答 → artifact 回传 全链路（前台路径已验证：928f289 前台锚点修复后 GJh7qg2n 任务注入正确会话并完成 git commit+push；权限/提问/input-required 未验）
- [ ] 文档页「命令」章节 claude 支持表格已更新（后台 ✅），但 claude 后台会话修复后需复核表述与实际行为一致

### 备忘

- [ ] a2a-inspector 互操作验证（规范符合性快检，可选）
- [ ] Windows 机本仓库工作区 ID：4g8rHi43MHaWurH9XYsGNH（2026-09-14 深夜重注册；旧 anKN3nc88cJnVND3cnjcmn 在本地库里不存在，已随 .agent-swarm.md 更新）
- [ ] nas_brain 工作区 ID：XYaR4TdtGqdqoAEW9vNn8g（旧 nDZDDucfudwSPmN5Nec3GU 已失效）
- [ ] DB 里可能残留脏 purpose 的工作区（2026-09-14 上午 headless 方案上传过对话屁话；agent_swarm 本仓库那条已用 update_info 覆盖，其他机器如有同类问题同样处理）
- [ ] npm install 慢（~40s）：可把 @opencode-ai/* 设为 peerDependencies
- [ ] teams 表清理（确认永不恢复后删）
- [ ] 文档页可补：任务派发权限交互（permission.asked 目标端 TUI 响应）还没写进 FAQ
- [ ] 前端 lint 有一个既存 warning（WorkspacesPage set-state-in-effect），非阻塞

## 环境/常用操作（Windows 本机）

```powershell
.\deploy\start.ps1           # 服务 :8700（前台运行，Ctrl-C 停止；幂等，已在跑则退出）
.\deploy\stop.ps1            # 注意：start.ps1 是前台运行，通常直接关窗口/Ctrl-C
cd web && npm run build      # 产物由 8700 托管，无需重启服务
cd web && npm run dev        # dev :8701
cd plugins/opencode && npm run typecheck   # tsc --noEmit
# 改了 plugins/opencode/src/ 后本机生效三步：
# 1. 同步到安装目录 %USERPROFILE%\.config\opencode\plugins\agent-swarm\src\
# 2. tar -czf data\agent-swarm-plugin.tar.gz -C . --exclude=node_modules --exclude=types --exclude="*.tsbuildinfo" plugins
# 3. 重启 opencode（必须，运行中的会话持有旧插件代码）
```

- 本机 serverUrl：`http://127.0.0.1:8700`，apikey 在 `~/.config/opencode/agent-swarm.json`（全局，TUI 插件读这个）与 `~/.config/opencode/plugins/agent-swarm/config.json`（server 插件兜底，两处应一致）；claude 侧在 `~/.claude/agent-swarm/config.json`
- opencode 插件日志：`~/.config/opencode/plugins/agent-swarm/plugin.log`（server/TUI 插件共用，TUI 行带 `[tui]` 前缀）
- claude 插件日志：`~/.claude/agent-swarm/keepalive.log`（含 A2A 任务/spawn/顶号日志，排查 claude 后台问题先看这里）
- opencode 运行日志：`~/.local/share/opencode/log/opencode.log`（TUI 插件加载报错看这里）
- 心跳 30s，90s 超时判离线；**时间戳全是 UTC**，用户在 UTC+8，别拿本地时钟肉眼对比心跳新鲜度（反复踩过，AGENTS.md 有记载）
- ⚠️ 改 plugins/opencode/src/ 后：同步 + 重打 tarball + 重启 opencode 才生效；改 plugins/claude/*.mjs 后：同步到 `~\.claude\agent-swarm\` + 重打 tarball + 重启 claude（keepalive 是 claude spawn 的子进程）
- ⚠️ 含中文的 ps1 安装脚本必须 UTF-8 with BOM
- 快捷排查：`Select-String -Path "$env:USERPROFILE\.config\opencode\plugins\agent-swarm\plugin.log" -Pattern "background|a2a" | Select-Object -Last 20`；claude 侧 `Get-Content "$env:USERPROFILE\.claude\agent-swarm\keepalive.log" -Tail 40`
