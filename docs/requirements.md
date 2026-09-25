# agent_swarm 需求与行为规格（现行）

> 更新: 2026-09-25 · 本文档定义系统**当前**的具体行为，是需求与验收的基准。
> 历史决策脉络（为什么变成这样）见 `TODO.md` 架构演进史；架构边界与坑见 `AGENTS.md`；用户视角功能介绍见 `README.md` / `README_CN.md`；外部客户端协议细则见 `docs/desktop-client-nexus-integration.md`。

---

## 1. 系统概述

agent_swarm 是一个多 agent 协作平台（虫群）：

- **服务端**：FastAPI 单进程（`:8700`），同时承载管理 REST API、MCP 端点、A2A 网关、插件分发、飞书/微信渠道网关。数据库 SQLite（WAL）。
- **插件**（`plugins/`）：注册工作区到中枢、心跳保活、接收执行 A2A 任务、上报前台会话监控流。支持 opencode（V1/V2 双版本）与 claude code。
- **Web 前端**：React SPA——网页中枢（Nexus）、工作区、调用记录、产物页、账号页、后台管理。
- **渠道**：飞书（自建应用）与微信 ClawBot（用户扫自己的微信）作为聊天侧入口，能力对齐（下发/监控/简报/权限应答）。

核心模型：**工作区（workspace）** = 一个注册到中枢的 agent 工作目录。任何授权用户可通过 web / MCP / A2A / 聊天渠道向工作区派发任务，并订阅其事件流。

## 2. 鉴权

| 凭证 | 形态 | 有效期 | 适用面 |
|---|---|---|---|
| apikey | `as_` 开头，账号页可查/重置 | 长效（重置即失效） | `/mcp/*` 全部；WS `/ws/nexus` hello；reply/history/rounds/workspaces/calls 等 REST（`get_user_either`） |
| JWT | 登录签发 | 24h | 全部 `/api/*`（除 auth）；与 apikey 在上述重叠端点二选一 |

行为规则：

- `/mcp` 每个请求（含 initialize）都校验 `Authorization: Bearer <apikey>`；apikey → user 的身份存 contextvar，MCP 工具经 `get_user()` 读取。
- `POST /api/nexus/{wid}/message:send` 与 `DELETE /api/nexus/{wid}/history` **保持 JWT-only**（最小改动决策）。
- apikey 重置：旧 key 立即失效，并用新 key 重加密该用户全部密文行（历史保持可读）。
- 静态加密：设置 `AGENT_SWARM_ENC_KEY` 后，任务指令/结果/错误、事件流原文、工作区描述/备注/会话标题一律密文落库（`enc1:<fernet>`，明文列清空）。**子密钥 = sha256(server_key + ':' + user_apikey)**——读侧必须用属主 apikey 解密，key 不匹配时静默回退明文列（表现为读到空串/`{}`）。外部 A2A 任务无属主，保留明文。丢失密钥 = 加密历史永久不可读。

## 3. MCP 工具（共 12 个，agent 的唯一操作面）

面向 agent 的所有操作都在服务端 MCP 工具里，插件不注入任何工具。任何 MCP 客户端（opencode / claude / 其它）连 `/mcp/` 即用。

| 工具 | 行为要点 |
|---|---|
| `workspace_add` | 注册当前目录为工作区；返回 ID，agent 写入项目根 `.agent_swarm/workspace.md` |
| `workspace_remove` / `enable` / `disable` / `offline` | 工作区管理；仅离线可删；disable 后心跳不复活，需 enable |
| `heartbeat` | 保活 + 上报当前会话（插件每 30s 调；90s 无心跳判离线） |
| `update_info` / `update_notes` | 更新用途/能力描述、备注 |
| `list_workspaces` | 列出当前用户可见工作区 |
| `a2a_call` | 派发任务：内部工作区 ID 或外部 A2A 端点 URL。可选 `wait_seconds`（≤3600）同步等终态。**禁止 target=自己**（`from_workspace` 注明且相同时服务端拒绝 "self-call loop"）；外部任务落同一张任务表（`external_url` 标记）经 `a2a_task` 轮询 |
| `a2a_task` | 查任务状态与结果 |
| `artifact_upload` | 两步上传（无 base64）：工具签发一次性 `upload_url`（10min/单次）→ `curl -F file=@路径` 直传原始字节 |

工程约定：每个工具必须用 `_ann()` 声明全部四个 annotation hint（readOnly/destructive/idempotent/openWorld），按真实行为赋值；新增/修改工具同步更新 `tests/test_mcp_tools.py`。

## 4. 任务模型与生命周期

任务统一落 `a2a_tasks` 表，`caller` 标注来源：`nexus-web`（网页中枢）/ `agent`（agent 互调）/ `a2a-client`（外部 A2A）/ `monitor`（前台监控轮）/ `nexus-feishu` / weixin 渠道。

状态机：

```
queued ──(发送+ack 成功)──> working ──> completed | failed
   │                          │
   │(发送失败/拒单/无ack→回退)  ├──> input-required ──(应答)──> working
   └──> canceled              └────(取消)──> canceled
```

- **排队**：任务创建即 `queued`；`dispatch_queued_for` 取第一个新鲜插件连接派发，**发送 + 插件 ack（30s 内）成功才置 working**；发送失败/插件拒单/超时无 ack 一律保持 queued 等下次派发，死连接剔除。密文任务派发前必须解密（ENC_KEY 下读明文列会派出空指令——历史事故）。
- **可派发判定** `dispatchable(wid)`：有插件连接 且（心跳新鲜 = 开着 TUI，或连接上报 `execution_mode=="background"`）。没开 TUI 的前台工作区不可派发（web 下发返回 409），任务排队。
- **执行位置**：前台注入优先（目标当前会话，实时可见）；后台模式 spawn 独立会话（同 caller 任务复用同一后台会话，映射存 `.agent_swarm/sessions.json`）。claude 一律后台 headless。
- **终态收尾**：`completed` 时插件发 artifact（最终回答全文）；`failed` 时错误文本入 `error` 列；`canceled`（用户主动中断）同样入档。超时为懒超时（`AGENT_SWARM_CALL_TIMEOUT` 默认 1h，读侧判定）。
- **input-required**：权限/提问等待态。应答走统一 reply 端点（§6）；**先答先算**——第一个应答生效，任务翻出等待态，其余渠道后续应答干净地 409。
- **前台唯一轮**：一个工作区同时只有一个前台监控轮，新一轮自动收尾上一轮（superseded）。

## 5. 事件流与订阅（`/ws/nexus`）

所有推送收口在 `_push_web` 单一出口，三种帧：

| 帧 | 载荷 | 说明 |
|---|---|---|
| `event` | A2A 事件（kind=status-update / artifact-update） | 状态流转、流式 thinking/text/tool（`metadata.nexus` 标注）、input-required 的 DataPart（permission/question） |
| `monitor` | 前台监控轮事件（扁平形状：roundKey/type/…） | user/reasoning/text/tool/permission/question/replied/idle 实时轮 |
| `task` | 任务行快照 | 状态变化/终态/应答自持后刷新 |

订阅语义：

- hello（apikey 或 JWT 二选一）→ subscribe：
  - **精确订阅** `{"workspace_id": "<wid>"}`：需属主（`_owns`），回执带最新一轮回放 + `first_id` 游标（更早的轮走 `GET /api/nexus/{wid}/rounds?before_id=`，全量走 `/history`）。
  - **通配订阅** `{"workspace_id": "*"}`：订阅本用户名下**全部**工作区；逐事件属主过滤（别人的收不到）；**不做历史回放**（回执 `note:"replay skipped for wildcard"`，历史走 REST）。一条通配连接等价 N 条精确订阅。
- 一条连接同一时刻只有一个订阅目标（重新 subscribe 先退订旧的）；多客户端（web/桌宠/飞书进程）可同时在线互不挤占。
- **终态简报摘要 `brief`**：completed 帧带 `brief.artifact`（最终回答截 1600）、failed 帧带 `brief.error`（截 700）；监控轮 idle 帧带 `brief.artifact`。只拼在 WS 推送的内存副本上，落库无此字段。订阅者（桌宠/第三方简报 UI）直接取用，无需自己解 artifact。

## 6. 权限 / 提问应答（跨渠道先答先算）

- 任务（A2A 轮）或监控轮进入 permission/question 时，若简报开启，**web + 飞书 + 微信（+桌宠）同时收到卡片**；TUI 本身也可答。
- 应答端点：`POST /api/nexus/{wid}/reply`，body 带 `task_id`（监控轮 = roundKey）、`type`（permission/question）、`request_id`、`reply`（once/always/reject）或 `answers`。
- 第一个应答生效并使任务离开 input-required；其余渠道应答返回 409（非错误，客户端应收起气泡刷新状态）。
- 插件权限/提问事件按 **requestId** 去重——同轮第二个权限是新 requestId，不得按轮去重。opencode 权限事件无 title，具体路径/命令在 `patterns[]`。

## 7. 渠道分发（飞书 / 微信）

两渠道能力对齐，传输不同（飞书卡片、微信纯文本编号选项）：

- **下发**：聊天窗口纯文本 = 向选中工作区派任务（caller=渠道名）。飞书走时间线多卡模式；微信整条消息详细流（💭/🔧/答案，无打字机）。
- **监控同步**：`monitor on` 的窗口实时收自己 TUI 对话轮（飞书逐卡、微信 💭/🔧 行）。
- **简报**：`brief on`（默认开）时，其它来源（web/agent/外部 A2A）的任务到 **completed/failed** 终态推摘要卡（指令首行 + 回答截 1500 / 失败原因截 600）；**canceled 不发**；监控轮 tool-only 空轮静默。收件范围 = **属主名下全部 brief_on 窗口**（属主过滤，防跨用户泄漏）。
- **权限/提问卡**：不受简报开关限制，任何来源任务等待输入即推（飞书按钮卡：允许/始终允许/拒绝；微信编号文本：1/2/3，纯数字应答）。
- 飞书绑定 `/swarm bind as_xxx`；微信扫码绑定（一账号一 bot，token ~24h 过期重扫）。
- 自发任务（caller=渠道自己）走时间线详情，不再发简报（避免重复）。

## 8. 产物（Artifacts）

- 上传两步（二进制不经 JSON）：MCP `artifact_upload` 签发一次性签名 `upload_url`（10min/单次/防重放）→ `curl -F file=@` 直传。
- 落盘 `data/artifacts/<id>_<name>`；TTL 7 天（`AGENT_SWARM_ARTIFACT_TTL_DAYS`），单文件上限 20MB（`AGENT_SWARM_ARTIFACT_MAX_MB`），每小时 GC；**pin 的产物永不过期**。
- REST：列表/固定/删除（JWT 或 apikey）、一次性凭证上传（免 JWT）、HMAC 签名下载链接（30 天有效，供 IM/浏览器免 header 点击）。
- 上传后按简报规则推属主绑定渠道（飞书文件消息 / 微信文件 item，失败降级文本链接）。

## 9. 监控模式（前台会话实时上报）

- opencode 插件把 TUI 日常对话按轮次实时上报（默认开，`/swarm-monitor` 切换，热生效）：用户提问 → 💭 thinking → 工具调用 → 回答，全量进事件流与调用记录（`[monitor]` 标注）。
- 只监控前台会话；中枢下发的任务轮不重复上报。V1/V2 插件均支持；V2 由 TUI 进程心跳（**在线 = 开着 TUI**），server 插件不心跳。
- 轮次生命周期：`message.updated`（user）开轮 → 流式部件 → idle 收轮；权限/提问置 input-required，`replied` 回 working。

## 10. 插件与安装

- **opencode**：V1（file:// 入口）与 V2（目录自动发现，`opencode --version` 分流）同时支持，安装脚本单向覆盖。V2 插件零运行时裸依赖；改 `src/` 后需同步安装目录 + `touch index.ts` 热重载。
- **claude**：keepalive.mjs 本地 stdio MCP 保活 + 后台 headless 执行（无前台注入）。
- **安装器**：`deploy/install.{sh,ps1}` 分发器 + `plugins/<name>/install-<name>.{sh,ps1}` 各自实现；tarball 含整个 plugins 树。含中文的 ps1 必须存 UTF-8 **带 BOM**。
- `/swarm-*` 命令 = markdown 源文件复制到 `~/.config/opencode/commands/`（claude 同理），改命令行为要改源 md 后重装。

## 11. 质量基线

- **测试**：`tests/`（pytest）——MCP 12 工具全覆盖 + annotation hints、派发链路回归（加密读回/ack 门控/回退 queued）、双鉴权四态、通配订阅属主隔离、终态 brief 帧。夹具 session 级（`AGENT_SWARM_DB` 指临时库，绝不触碰生产 DB）。改动服务端行为必须跑：`$env:PYTHONPATH="."; .\.venv\Scripts\python.exe -m pytest tests/ -q`。
- **稳定性红线**（历史事故换来，违反必炸）：
  1. `with Session(engine)` 块内**一律不 await/yield**（SQLite 连接池同步检出会冻死整个事件循环）；
  2. 任何任务行变更必须显式 `session.commit()`；
  3. monitor 推送必须走 `_push_web(..., "monitor")`（双包一层前端就丢整条实时流）；
  4. input-required 期间的流式帧不得把任务行顶回 working；
  5. 属主校验（`_owns`）在任何跨用户推送/读取路径上不可省略。
- **时间戳全部 UTC**（DB/日志）；用户在 UTC+8，禁止肉眼看时间差判断心跳新鲜度。
- git：只在 `dev` 上开发提交；**master 合并由用户触发**，禁止顺手合并。push 用 `git -c http.version=HTTP/1.1 push`。
- 部署：docker 多阶段构建（node 建 web → python 运行时）；`deploy/start.*` 本机启动（Windows 必须用 `.venv\Scripts\python.exe`，系统 Python 无依赖）。

## 12. 明确不做 / 已废弃

- 不做团队（teams 表保留但功能已移除，勿接回）。
- 不做 `register_workspace`/`workspace_whoami`（workspace_add 覆盖）。
- 不把 MCP 工具挪进插件（MCP-first 决策）。
- 微信不做群聊、不做卡片/按钮、不做打字机流式。
- V2 server 插件不做提问（form）应答（ctx 无能力，等官方补）。
- 飞书/微信自发任务不发简报（时间线已有）。
- 通配订阅不做历史回放。
