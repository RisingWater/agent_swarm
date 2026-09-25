# agent_swarm 开发进度 TODO

> 更新时间: 2026-09-25 · Linux 开发机（/home/wangxu/workdir/agent_swarm，workspace ID HQDCqedTfoHWKfaSxSJoKg；线上服务 10.17.17.19:8700 容器 agent-swarm）

> **2026-09-25：桌宠（dsh-pet）对接批次落地——双鉴权（hello apikey/reply 等 5 端点）、派发链路可靠化（密文读回+ack 门控 working）、插件接单即 ack、WS 通配订阅 "*"；测试从零建起 26 例**，详见架构演进史 09-25 条
> 服务已跑在 :8700（容器内 · 前端构建产物由 8700 静态托管）；本机 opencode 已是 **v2.0.15**
> **alpha-v0.1 已发布**（tag = dev 快照 d3daafa，master 为其发布流水；GHCR 镜像 CI 就绪）。0.1 后主线：nexus-feishu 飞书渠道、后台管理页（详见 git log，TODO 未逐条补记）；落库加密已完成；**nexus-weixin-clawbot 微信渠道真机 E2E 已过（2026-09-20）**，含跨渠道权限四方先答先算
> **2026-09-23：opencode V1/V2 双版本插件支持已打通（心跳/前台注入/后台模式/监控实测；权限/取消/续聊待验）**，详见「已完成」首节

## 项目一句话

多 agent 协作平台（虫群）：FastAPI 单服务（管理 API + MCP 端点 + A2A 网关 + 插件分发）+ 多 agent 插件（plugins/ 下 opencode / claude）+ 纯 React 前端。面向 agent 的操作全部走服务端 MCP 工具；工作区互调 / web 中枢 / 外部 agent 统一走 A2A 协议（`server/nexus_a2a.py` 手写子集）；插件负责心跳保活 + A2A 任务接收执行 + 前台会话实时监控上报。敏感内容可选密文落库（`server/crypto.py`，`AGENT_SWARM_ENC_KEY` 开启）。

## 架构演进史（历次用户拍板，读懂再动手）

- **2026-09-11 v0**：插件注入 8 个 swarm_* 工具 + request_help 求助闭环 + LLM 惰性总结目录
- **2026-09-12 MCP-first（用户拍板）**：**MCP 工具是唯一面向 agent 的接口**，任何 MCP 客户端（claude/deepseek harness/…）直连 /mcp 即用，可移植性优先；插件瘦身为心跳保活；工作区 ID 持久化到项目根 `.agent_swarm/workspace.md` 的 `WORKSPACE_ID:` 行（register_workspace/whoami 已删，workspace_add 一个工具覆盖）
- **2026-09-12 workspace_call**：跨 agent 任务派发上线（前台注入优先，后台会话兜底，权限由目标端用户在 TUI 响应）；旧 request_help/poll/submit 双模式设计整体删除
- **2026-09-13 claude 接入**：keepalive.mjs 零依赖 stdio MCP 保活
- **2026-09-14 A2A 化（替换 workspace_call + nexus 自定义协议）**：统一走 A2A 0.3.x 子集（手写，无官方 SDK）
- **2026-09-14 后台会话（用户拍板）**：后台会话必须在独立会话执行（复用前台会话会上下文互串）；同一来源（caller）的任务归组到同一后台会话（映射表 `.agent_swarm/sessions.json`，键=caller）；opencode 后台 spawn 加 `--pure`（不加载插件）+ `--thinking`（reasoning 流）
- **2026-09-14 claude 只做后台（用户拍板）**：claude 无前台注入，全部任务走 headless `claude -p` 后台执行；keepalive 进程兼任 A2A 任务接收
- **2026-09-14 /swarm-* 命令 TUI 化**：md 命令 → 原生 TUI 命令（tui.ts）；后 /swarm-add 因 headless 总结方案废弃**回退 md 命令**，其余 4 个保持 TUI
- **2026-09-15 监控模式（用户拍板）**：前台会话实时监控——TUI 日常对话按轮次实时同步网页中枢，与 A2A 任务轮混排（单 event hook 管道分流，中枢任务不重复上报）；只监控前台会话；`/swarm-monitor` 开关默认开；监控轮入调用记录（[monitor] 标注，双方=工作区自己）；权限远程应答与 A2A 轮共用 reply 端点
- **2026-09-15 本地状态目录化 + 后台会话收尾**：工作区本地状态统一收进项目根 `.agent_swarm/`（`workspace.md` 的 WORKSPACE_ID + `sessions.json` 的 caller→后台会话映射）；claude 后台会话全链路修复（Linux 机：strict-mcp-config 启动、input_json_delta 累积工具输入、事件缓冲跨 WS 断连、server 侧 working 超时 reaper）；web 中枢给 claude 拆专属 claude-tui 终端主题与控制；服务端关掉 MCP SDK 的 DNS rebinding host 校验（LAN IP 客户端直连）；docker 镜像内嵌 plugin-dist（不再依赖外部挂载）
- **2026-09-16 nexus-feishu 飞书渠道（用户排期第 1 项）**：飞书自建应用（服务端 env `FEISHU_APP_ID/SECRET`）接入中枢，caller=nexus-feishu，复用 A2A 下发/事件流/应答链路；`/swarm bind as_密钥` 绑定；卡片对齐 opencode-feishu 风格——**timeline 时间线多卡模式**（用户卡→💭思考→逐工具卡→🤖回答）、未知指令（含所有非 /swarm 斜杠命令）→ 状态摘要+命令按钮菜单卡、sequence 冲突修复
- **2026-09-17 简报模式 + 前台唯一轮 + 聊天绑定管理（用户拍板）**：聊天渠道区分「详细流/监控模式」（你自己 TUI 对话实时直播）与「**简报模式**」（其它来源——web/agent/外部 A2A 派发的任务完成后推摘要卡，默认开）；一个工作区同时只有一个前台轮次（新一轮自动收尾上一轮，杜绝永远 running）；web 账号页「聊天工具绑定」统一管理各窗口的 workspace/monitor/brief；调用记录显示真实发起工作区（a2a_call 加 from_workspace）；显示飞书真实用户名
- **2026-09-18 权限/提问卡无条件推 + 后台管理页 + 发行准备**：权限/提问卡**不受简报开关限制**（任何来源任务等待输入即推飞书，权限可远程应答优先）；彻底移除 1800s 任务超时收割（改为懒超时，见 `AGENT_SWARM_CALL_TIMEOUT`）；新增后台管理页（`/#/admin` 独立登录：面板/用户/工作区/调用记录 tab）；CI 构建镜像推 GHCR（v* tag 或手动触发）；README 重写双语（功能摘要/部署/详细功能三段）+ **双许可（AGPL-3.0 + 商业许可）+ CLA**
- **2026-09-19 静态内容落库加密**：`AGENT_SWARM_ENC_KEY` 可选启用；**子密钥 = sha256(server_key+":"+user_apikey) 每用户独立**——盗库文件单独无用；密文 `enc1:<fernet>`；存量明文幂等回填、密钥轮换恢复密钥、apikey 重置联动重加密；加密列（purpose/notes/session_title/message/artifact/error/payload）
- **2026-09-19 微信 ClawBot 渠道（nexus-weixin-clawbot）**：与飞书同构但传输完全不同——官方 Tencent iLink Bot API 2.4.6（HTTP/JSON 长轮询，无 SDK，协议参考 D:\wangxu\work\weixin-ClawBot-API）；**每用户扫自己的微信做成 bot**（一人一行表，token 加密落库，无服务端 env 配置）；扫码二维码是 liteapp URL → qrcode[pil] 渲染 PNG；仅私聊、回复必须带最近入站 context_token、getupdates 游标持久化、token ~24h 过期重扫；**无卡片无按钮**——权限/提问渲染为编号文本选项（1/2/3 → once/always/reject），**纯数字应答**
- **2026-09-19 分发模型统一（用户拍板，docs/channel-dispatch-design.md）**：微信自己派的 A2A 任务 → **详细流**（💭思考/🔧工具行/最终回答全量，终态免简报）；监控轮 → monitor_on 推详细流 + idle 有最终回答才简报（tool-only 空轮静默）；其它来源（web/飞书/agent 互调/A2A 外部）→ 终态简报 + input-required 单卡；飞书侧对齐（简报入口跳过 artifact 为空的监控轮）
- **2026-09-20 跨渠道权限/提问四方先答先算（用户拍板）**：TUI 监控轮或 A2A 任务拉起 permission/question 且简报开着 → **web/飞书/微信同时收卡**，谁先应答谁生效、任务翻出 input-required、其余渠道后续应答干净失败；插件权限/提问改按 **request id** 去重（`inputSeen`/`a2aInputSeen` 集合，非单值状态——同轮第二个权限曾全渠道被吞）；opencode 权限事件**无 title**、路径/命令在 `patterns[]` → 渠道卡显示 `访问/执行：<patterns>`；微信渠道真机 E2E 全过（任务详细流/权限应答/简报/菜单/监控同步）
- **2026-09-22 产物功能（MCP 第 12 个工具 artifact_upload）**：agent 输出的文件不再只存在于远端——**上传走两步（无 base64）**：MCP `artifact_upload` 签发一次性 signed `upload_url`（10min/单次/防重放），agent `curl -F file=@<path>` 直传原始字节；服务端落盘 `data/artifacts/<id>_<name>`（TTL 7 天 `AGENT_SWARM_ARTIFACT_TTL_DAYS`、上限 20MB `AGENT_SWARM_ARTIFACT_MAX_MB`，pinned 永久保留不自动清，main.py lifespan 每小时 GC）；REST：`GET /api/artifacts` / `PUT {id}/pin` / `DELETE {id}`（JWT）+ `POST /api/artifacts/upload`（一次性凭证免 JWT）+ `GET {id}/download?token=`（HMAC 签名 30 天，IM/浏览器点击场景——发不了 header 只能用 query）。上传后按简报规则推属主 brief_on 窗口：飞书 `im.v1.file.create` → 文件消息（失败降级文本链接）；微信 iLink 文件 item（type-2，未验证）失败降级文本链接。**请求基址**：ApiKeyMiddleware 记录 `current_base_url` contextvar（PUBLIC_URL → x-forwarded-* → host），MCP 工具据此拼绝对链接后方可用。web 新增「产物」页（文件名/下载/大小/时间/保留倒计时/固定 toggle/删除二次确认/30s 自动刷新）；opencode+claude 两处 skill 写明 artifact_upload 两步用法
- **2026-09-23 多实例重连风暴冻死修复（用户报障，仅 dev）**：同项目多开 opencode 抢同一 `plugins[wid]` 单槽，服务端"新顶旧(4001)"+客户端 1s 无条件重连 → 每秒互踢磨光 15 个连接池、同步取连接阻塞事件循环、全站冻死（全天 15222 次连接仅 9 次自然断开）。改为一**个工作区保留多条连接**（`plugins[wid]` 单槽→列表），删除踢人；派发取 `primary_conn`（第一个新鲜连接，发送失败剔除并顺次回退）；应答按**连接自己上报的 session** 路由（工作区行的 session_id 会被多实例心跳互相覆盖，不可用）；SQLite WAL + busy_timeout + 池 30；**`with Session` 内一律不 await/yield**（顺带修掉 tasks/cancel 与超时置 failed 漏 commit 的真 bug）
- **2026-09-23 opencode V2 支持（用户拍板：同时支持 V1+V2，安装脚本按版本分流；先打通心跳上线）**：V2 插件 API 全新——入口 `Plugin.define({id, setup})`、插件由**后台 service 按 location 常驻加载**（`opencode run` 只是客户端，`--pure` 已删）、**强类型命名事件**（非 V1 的 message.part.updated）、**无 `session.list`/`session.form`**。仓库双实现：V1 的 `src/index.ts`/`src/tui.ts` 原样不动 + 新增 `plugins/opencode/index.ts`（V2 包入口）/`tui.ts`（V2 CLI 入口）/`src/v2/*`；V2 插件**刻意零运行时裸依赖**（`@opencode/plugin` 只 `import type`）——否则配置目录下的插件在 opencode 加载器里解析不到该包；安装脚本 `opencode --version` 判 major 分流、单向覆盖
- **2026-09-23 V2 在线语义 = 开着 TUI（用户拍板）**：V2 插件常驻 service，若由 server 插件心跳，则 service 加载过的每个项目（没开 TUI 也算）都会 online（用户实测反馈）。改为**在线只能由 TUI 自己上报**：server 插件不心跳，CLI 插件（TUI 进程）每 30s 心跳 + 上报当前查看的会话；关掉 TUI → 90s 超时离线（不主动 offline，防同项目多开互踢）
- **2026-09-23 离线派发策略 C（用户拍板）**：新增 `dispatchable(wid)` = 有插件连接 且（心跳新鲜=有 TUI **或** 连接上报 `execution_mode=="background"`）。即**没开 TUI 的前台工作区不可派发（409）**，后台模式照常可派（常驻 service 插件代跑）；插件在 WS hello/ping 上报执行模式，`/swarm-mode` 切完下一次 ping 生效
- **2026-09-23 A2A 轮权限应答 409 修复（用户实测 V1/V2 同样复现 → 锁定服务端）**：`handle_plugin_event`（A2A 轮事件入口）从 18de0c9 起**只做终态收尾，从不把 working/input-required 写回任务行**，而 web 下发的 `_send_message_core` 也不标 working → A2A 轮任务行**永远停在 queued**（accepted_at=None）→ `/reply` 对非 monitor 任务严格校验 `input-required` → 409 "task is queued, not waiting for input"（用户看到的 queueing not working）。权限 E2E 此前全过的都是监控轮（`handle_monitor_event` 有完整写回）+ feishu/weixin reply（`reply_task_from_feishu` 不校验状态），A2A 轮 web 应答属**首次真验**暴露的既有缺口（与插件版本无关）。修复：① `handle_plugin_event` 补非终态写回——working：queued→working（补记 accepted_at）/ input-required 且事件带 `metadata.replied`→working（input-required 期间的 text/tool 流式帧是 working 状态，**不得顶回**，对齐监控轮 566-569 的坑）；input-required：非终态→input-required。② `nexus_reply` / `reply_task_from_feishu` 转发成功后服务端自持 input-required→working（V1 插件不回发 replied 事件，不依赖插件回执）
- **2026-09-25 桌宠（dsh-pet）对接批次：双鉴权 + 派发可靠化 + 通配订阅（agent 互调派单驱动，docs/desktop-client-nexus-integration.md）**：① **双鉴权**——WS `/ws/nexus` hello 支持 apikey（与 token 二选一，`_auth_apikey` 复用，长效免 24h 重登录）；新增 `_require_user_http`（JWT 或 apikey 任一）切换 reply/history/rounds 三端点；`GET /api/workspaces`、`/api/calls` 列表+删除同款换 `get_user_either`（workspaces:56 曾漏换被桌宠实测 401 抓到）。② **派发链路可靠化**——`dispatch_queued_for` 两连修：密文任务解密读回（**ENC_KEY 下读明文列派空指令**，插件 "text required" 拒单无痕、任务卡 working 的根因，nmj9ZdVL 事故）；顺序反转为**发送+ack（30s）成功才置 working**，发送失败/拒单/无 ack 一律回退 queued 等重试，死连接剔除，补 accepted/rejected/no-ack 日志（fY8LWdS2 超时无 agent 领取的另一半根因）。③ **插件接单即回 ack**（V1/V2 `onTask` 加 `onAccepted` 回调，nexus_a2a.ts 幂等 ack）——前台长任务不再拖满服务端 30s（V2 prompt 整轮才 resolve 的历史包袱）。④ **WS subscribe 通配 `"*"`**——订阅本用户全部工作区（`all_subscribers` 注册表 + `WebConn.all_workspaces`），`_push_web` 推送时逐事件 `_owns` 属主过滤（2026-09-18 跨用户泄漏教训必须保留）；**通配不做 history 回放**（回执 note 提示，历史走 REST）；与飞书/微信「属主全局」简报语义对齐（IM 是 internal_listeners 进程内广播 + 查库按属主收件，web 是按 wid 定向，桌宠现在两全）。⑤ **测试从零建起**：tests/ 26 例（MCP 12 工具全覆盖+四 annotation hint 校验、派发回归、双鉴权四态、通配隔离），夹具 session 级共享。**待办残留**：插件重装+重启 opencode 后验接单即 ack E2E；web 前端 `subscribed` 回执要兼容 `workspace_id:"*"`（现 web 只订单个 wid，不影响但留意）
- ~~**headless spawn opencode 生成 purpose**~~（2026-09-14 已废弃）：挂 `--session 当前会话` 把对话上下文带进总结上传过屁话；专属 summarySessionId 复用会话方案复杂度又高，写了又删。purpose 回归前台 agent 自己分析（md 命令流程）
- ~~teams 团队功能~~（API/前端已删，**表保留**，用户"想好后再加"）
- ~~request_help 求助体系~~（被 workspace_call 替代后整体删除，help_requests 表已 DROP）
- ~~workspace_call 自定义协议~~（被 A2A 替代，workspace_calls 表已 DROP，改 a2a_tasks）
- ~~视频走 git lfs~~（放弃：mp4 39MB 普通 blob 已推送成功，用户接受仓库变大）
- ~~e2e 测试脚本~~（用户 2026-09-12 决定放弃，scripts/test_plugin_smoke.ts 是死代码可删可留）

## 已完成（除注明外均已进 git）

### opencode V1/V2 双版本插件支持（2026-09-23，核心链路实测；仅 dev 未合并 master）

> 背景：本机 opencode 已升级 **v2.0.15**，V1 插件实现在 V2 **完全不运行**（官方明确）→ 全部工作区掉线。用户拍板「同时支持 V1+V2，安装脚本按版本分流」，并"先搞定心跳上线"。

- ✅ **V2 加载规则（实测踩出来的，安装脚本据此）**：`opencode.jsonc` 的 `plugins` 条目必须是**目录的纯路径字符串**（指向文件的 `file://` 报 `configured plugin path must be a directory` 被丢弃）；目录里必须有**根 `index.ts`**（不读 package.json exports/main）；**配置目录下的插件解析不到 `@opencode/plugin`**（在插件目录或 `<config>/node_modules` 装都没用）→ 插件必须**零运行时裸依赖**（`@opencode/plugin` 只 `import type`；`define` 实测是恒等函数，直接导出对象即可）。满足后 V2 **自动发现** `<config>/plugins/agent-swarm/{index.ts,tui.ts}` 即可加载，无需任何配置条目、无需 node_modules
- ✅ **仓库结构**：新增 `plugins/opencode/index.ts`（V2 server 入口，转发 `src/v2/index.ts`）+ `tui.ts`（V2 CLI 入口，转发 `src/v2/tui.ts`）+ `src/v2/{index,tui,background}.ts`；**V1 的 `src/index.ts`/`src/tui.ts` 与共享模块（nexus_a2a/client/config/sessions/wsfile）原样复用、未改动**（用户确认无需 V1 回归）
- ✅ **V2 server 插件事件管道**（`src/v2/index.ts`）：`ctx.event.subscribe()` 是**全局事件流**（每个 location 实例都收到所有 location 的事件）→ 必须按 `event.location.directory` 过滤；无 location 的 `session.execution.*` 只接受本实例已知会话。事件按 V2 强类型命名改写——`session.inbox.enqueued`（自带提问文本）、`session.text/reasoning.delta+ended`、`session.tool.input.started`(带 name)/`called`/`success`/`failed`、`session.execution.succeeded/failed/interrupted`（**收尾信号，非 session.idle**）、`permission.asked`、`form.created`、`session.error`
- ✅ **任务执行**：前台注入 `ctx.session.prompt({sessionID,text,delivery:"steer"})`、读消息 `ctx.session.context`、artifact 回传；踩坑：**V2 的 prompt 等到整轮结束才 resolve**，任务轮必须在注入**前**标记已开始（否则收尾判断不到、任务卡 working）；服务端下发的脏 session_id 用 `session.get().location.directory` 校验归属后才用
- ✅ **后台模式**（`src/v2/background.ts`，从 V1 复制 + 两处改）：去掉 `--pure`（V2 插件由 service 加载，`opencode run` 不会再起插件实例；该标志也已从 V2 删除）、Windows bin 路径 `opencode-ai`→`@opencode/cli`；`opencode run --format json` 事件形状与 V1 相同
- ✅ **V2 CLI 插件**（`src/v2/tui.ts`）：5 条命令 `/swarm-mode /swarm-monitor /swarm-remove /swarm-enable /swarm-disable` 迁到 `context.keymap.layer` + `ui.dialog.select` + `ui.toast.show`；坑：**`keymap.layer` 必须在 `ui.slot({append:"app"})` 的 render 里注册**（直接调报 `Keymap.Provider is missing`）；该插件还承担**在线心跳**（每 30s 调 MCP heartbeat + 上报 `router.current()` 里当前查看的会话）
- ✅ **权限应答**：`ctx.permission.reply({sessionID,requestID,decision})`；权限卡取值 `action`→permission、`resources`→patterns
- ⚠️ **提问（V2 改叫 form）**：server 插件 ctx **没有 `session.form`**（只有 CLI/TUI 插件有）→ 用户决策：**只上报、不应答**，后续按 V2 兼容问题反馈官方
- ✅ **服务端**：多连接改造（见架构演进史首条）、离线派发策略 C（`dispatchable`）、`PluginConn.execution_mode`（WS hello/ping 上报）
- ✅ **安装脚本分流**（`install-opencode.sh|.ps1` 对称）：`opencode --version` 判 major（>=2 → V2）；V1 分支保持原行为（plugin 数组 file:// + tui.jsonc + `mcp["agent-swarm"]` + 链接依赖），V2 分支不装依赖/不写插件配置（自动发现）/MCP 写 `mcp.servers["agent-swarm"]`（V2 用 disabled 反向）/清理另一版本残留条目；用假 HOME + stub opencode 实测两分支生成配置正确
- ✅ **实测通过**：心跳上线（online/offline 语义正确）、前台注入任务 `completed` + artifact 回传、后台任务 `completed`（bg-ok）、监控轮落库且 `completed`（text/reasoning/tool 齐全）；`tsc --noEmit` 与 server `py_compile`、`dispatchable` 组合逻辑单测均过
- ⚠️ **待验证**：权限 input-required **应答**全链路（从没真弹过权限框）、取消（`session.interrupt`）、后台续聊 resume、`session.error`→failed、5 条命令的交互行为、ps1 在 Windows 实机（只做了 BOM/括号静态检查）
- ⚠️ **未部署**：服务端改动（多连接/不阻塞/连接池加固/dispatchable）需**重建镜像**才生效；线上目前仍是旧镜像（且旧镜像里没有 V2 插件——其它机器今天跑安装命令拿到的还是 V1 插件，不受影响）

### 产物功能（2026-09-22，已提交推送；IM 推送真机已验）

> Agent 产出文件回传：MCP `artifact_upload` 签一次性上传 URL → agent `curl -F` 直传 → 服务端落盘 + IM 推送（飞书文件消息/微信文件 item，降级文本链接）+ web「产物」页管理。**无 base64**（二进制不出现在 JSON 请求体里）。

- ✅ **服务端 `server/artifacts.py`**：`artifact_upload` 签发一次性 signed `upload_url`（10min 有效/单次使用/防重放），`GET {id}/download?token=` HMAC 签名 30 天（IM/浏览器点击场景——发不了 header 只能用 query token）；token 签名逻辑全在这模块
- ✅ **落盘与清理**：`data/artifacts/<id>_<name>`，TTL 7 天（`AGENT_SWARM_ARTIFACT_TTL_DAYS`）+ 大小上限 20MB（`AGENT_SWARM_ARTIFACT_MAX_MB`），**pinned 行永不自动删**；main.py lifespan 每小时 GC（启动先清一次）
- ✅ **上传两步走**：MCP 工具只管签发（不出二进制），agent `curl -F file=@<path>` 直传原始字节到 `POST /api/artifacts/upload?nonce=&token=`（一次性凭证免 JWT）
- ✅ **REST**（JWT）：`GET /api/artifacts`（列表 + 签名下载链接）、`PUT {id}/pin`、`DELETE {id}`（仅属主）
- ✅ **IM 推送**（按简报规则推属主 brief_on 窗口）：飞书 `im.v1.file.create` → 文件消息，失败降级文本链接；微信 iLink 文件 item（type-2，尚未在真机验证渲染）失败降级文本链接
- ✅ **请求基址**：ApiKeyMiddleware 记录 `current_base_url` contextvar（PUBLIC_URL → x-forwarded-* → host），MCP 工具据此拼绝对下载链接
- ✅ **web「产物」页**（顶部导航）：文件名（点击下载）/大小/上传时间/保留倒计时/固定 toggle/删除（二次确认 Modal，30s 自动刷新）；首页与文档页补产物管理说明（e2f4986）
- ✅ **skill**：opencode + claude 两处 `artifact_upload` 两步用法章节
- ⚠️ **修复轮（579e57f）**：① 飞书 SDK 响应字段名错误——`CreateFileResponseBody` 是 `file_key` 不是 `file_id`（线上 AttributeError，上传成功但推送崩，走异常分支没发文件）→ 已改；② 产物页删除确认从行内气泡改居**中 Modal**（grid td `overflow:hidden` 气泡被单元格裁剪且相邻行遮挡）

### 微信 ClawBot 渠道 nexus-weixin-clawbot（2026-09-19 实现 + 2026-09-20 真机 E2E 全过）

- ✅ **模型**：`weixin_logins` 表（一人一行：每用户扫**自己的**微信号登录为 bot，本人 ↔ ClawBot 会话私聊；bot_token 走 crypto 按用户 apikey 加密落库 `token_enc`；cursor_buf 游标/context_token/workspace/monitor/brief 同表）
- ✅ **`server/weixin/gateway.py`**：iLink 2.4.6 HTTP 客户端（头规范/随机 UIN/base_info/ret=-14 判失效）+ 扫码登录（get_bot_qrcode→get_qrcode_status 轮询：wait/scaned/need_verifycode/scaned_but_redirect 切节点/confirmed）+ **每用户会话管理器**（getupdates 长轮询、游标持久化、-14 置 need_relogin、服务重启 start_all 恢复）
- ✅ **`render.py`**：简报 MD（提问首行+回答/失败原因）、监控 thinking 文本、tool 官方 item（type 11/12）+ 文本行降级、权限/提问文本编号卡
- ✅ **`commands.py`**：/swarm help|list|select（编号回复）|status|last|monitor on/off|brief on/off|/time|/重新连接；普通文本 = 待应答任务优先路由（reply_task_from_feishu 通用复用）→ 选中工作区下发（caller=nexus-weixin-clawbot）
- ✅ **`bridge.py`**：internal_listeners → 简报推终态 MD、input-required 推文本卡+入待应答、监控轮按 monitor_on 转发（thinking 文本/tool 官方 item 带降级、节流去重）
- ✅ **登录 API**（JWT）：login/start（二维码 HTTPS 链接直出）/login/status（1.5s 前端轮询）/login/verify（配对码）/login/cancel/logout/status/settings
- ✅ **web 账号页**：「聊天工具绑定」tab 飞书区块**下方**新增微信 ClawBot 区块——未登录显示二维码+配对码输入；已登录显示账号/选中工作区（复用 NexusWorkspaceSelect）/monitor/brief 开关/断开按钮
- ⚠️ **待真机 E2E（下一步必做）**：① 扫码后微信里出现 ClawBot 会话、本人发消息 getupdates 能收到（from_user_id=本人）② 官方 tool_call item（type 11/12）在普通微信客户端的显示效果 ③ Markdown 简报的实际渲染 ④ GENERATING 流式（用户已拍板**不做**打字机流式）
- ⚠️ 已知约束：仅私聊（官方 ChatType=direct）；回复必须带最近入站 context_token（用户久未发言推不出去，重启后靠 DB 恢复）；媒体消息（AES+CDN）v1 不做
- ✅ **E2E 修复轮（2026-09-19 下午，真机扫码后）**：
  - 扫码登录 500（`gateway.httpx_client` 残留引用）→ 内联 httpx client
  - 二维码显示为链接不是图片（iLink `qrcode_img_content` 是 liteapp URL，文档急开局节明确提过）→ 服务端 qrcode[pil] 渲染成 PNG data URI
  - confirmed 后二维码残留（flow 终态不清理）→ confirmed/expired/error 都 pop flow + 关轮询 client；前端已连接视图不再显示二维码；过期/出错回未登录视图显示红字提示 + 重新获取按钮
  - 提示文案折行（自己加的 maxWidth 画蛇添足）→ 去掉
  - **消息无反应根因**：`gateway._handle_msg` 调了不存在的 `bridge.handle_inbound`（实际在 commands.py）→ 已接线；日志证明消息接收/from 过滤/游标推进全部正常，断在最后一跳
  - 监控轮简报刷屏（"无最终回答文本"）：监控轮（caller=monitor）常无 text 事件（tool-only 轮），artifact 为空 → bridge 排除 caller=monitor 的简报（对齐飞书侧排除自身渠道）；微信简报只推渠道下发的任务（nexus-weixin-clawbot/nexus-web/agent 等的 artifact 是完整的）
  - **交互菜单化**（用户要求）：`/q` 出命令菜单回 /1-/7 执行；/swarm select 与未选工作区时自动出编号选择列表（/N 选择）；未识别 / 命令回菜单；监控/简报开关不带参数即翻转；交互状态 `_menus[uid]`（TTL 5 分钟）
  - 排查期日志：`data/weixin.log`（收发消息/过滤判定全链路），E2E 通过后可删
- ✅ **分发模型统一（2026-09-19 晚，按用户拍板模型，设计文档 docs/channel-dispatch-design.md）**：
  - **微信自己派的 A2A 任务 → 详细流**（此前完全没有）：`bridge._stream_task_event` 推 💭 thinking 文本、🔧 tool（官方 item 优先/文本降级，按 callId 节流）、input-required 编号选项卡（入 pending）、completed 时**最终回答全量一条**（artifact 优先，流式 text 不逐段发防碎片刷屏）；**终态免简报**（详细流已覆盖，`_brief_round` 加防御性 caller 守卫）
  - **监控轮（TUI）**：monitor_on 推详细流（现状保留）+ idle 后有最终回答才发简报（tool-only 空轮静默）
  - **其它来源**（web/飞书/agent 互调/A2A 外部）：终态简报 + input-required 单卡（现有逻辑保留）
  - A2A 事件 metadata.nexus 为 **snake_case**（call_id/tool_state/part_id/mode，插件 nexus_a2a.ts:135 定义）——与 web 前端 camelCase 读法不同，桥接层必须用 snake_case
  - 飞书侧 F2 微调：brief.py 监控轮 artifact 为空跳过（同微信守卫，防"无最终回答文本"卡刷屏）
  - ⚠️ 真机验收清单见 docs/channel-dispatch-design.md §6（微信派任务全程详细流/权限应答/监控轮简报/飞书不回归）
- ✅ **E2E 第二轮修复（2026-09-19 晚）**：
  - tool 消息重复四条：opencode running 阶段多次 part.update，call_id 去重失效 → **只发完成行**（✓/✗，天然一次），start 行取消
  - tool 文本行带参数（用户要求）：`🔧 bash \`git status\` ✓` / `🔧 read \`D:/x/y.py\` ✓`（command/file_path/pattern 等键提取，120 字截断；任务流+监控轮统一）
  - 官方 type 11/12 item 路径移除（真机证实普通微信客户端不渲染），gateway.send_tool_items 保留备用
  - **permission 卡不达微信根因**：插件 `handleA2aRound` 的权限/提问去重借用了 `monRounds.inputState`，A2A 轮结束后无人清理——第一次权限后同 session 的后续权限全部被静默吞掉 → 改为独立 `a2aInputSeen` 集合（按 request.id 去重，session.idle 清空）
  - 旧版 render 的 meta 污染手误（`(m or {}).get("nexus") and (...)` 产生空串）曾致 input-required 事件处理崩溃——已在实现轮清理，事故版本服务仍在跑过一段时间
  - 插件已同步安装目录 + tarball 已重打；**需重启 opencode** 生效
- ✅ **真机 E2E 完成（2026-09-20）**：全链路验证通过——扫码登录、账号页二维码（qrcode[pil] PNG）、消息收发、任务派发详细流（💭/🔧/最终回答全量免简报）、权限编号卡应答（1/2/3 → once/always/reject）任务放行、简报、命令菜单、/q、监控同步
- ✅ **跨渠道权限/提问四方先答先算（2026-09-20，用户拍板）**：TUI（监控轮）或 A2A 任务拉起 permission/question 且简报开着时，web / 飞书 / 微信同时收卡，谁先应答谁生效，任务翻出 input-required，其余渠道后续应答干净失败。飞书 perm_card 支持无 kind 扁平 monitor payload（`from_monitor=True`），微信 monitor 分支推编号卡+入 pending；应答端点统一 `reply_task_from_feishu(task_id=roundKey)`。设计见 docs/channel-dispatch-design.md §4.6
- ✅ **插件权限去重改 request id**（2026-09-20）：监控轮 `inputState` 单值状态去重曾致同轮第二个权限（新 id）被吞（TUI 弹框但微信/飞书静默）→ 改按 `inputSeen`（监控轮）/`a2aInputSeen`（A2A 轮）集合按 request.id 去重，reject/应答后同类型可再次上报
- ✅ **permission 卡带 patterns[]**（2026-09-20）：opencode 权限事件无 title，路径/命令在 `patterns[]`——插件 A2A+监控轮都带上，微信卡显示 `访问/执行：<patterns>`、飞书权限行同（修复"卡面显示轮首用户指令"）
- ✅ **受理回执去掉任务 ID**（2026-09-20，微信派任务后）：`render.task_accepted_text` 文案改为「📨 已派发任务，执行中。过程会实时同步到这里；发送 /swarm status 可查进度。」
- ⚠️ 遗留：微信排查日志 `data/weixin.log` 保留（wx-route/wx-monitor 全链路，后续渠道排障有用）；真机测试单 `D:\test_perm3\` 等目录仅演示用

### 静态内容落库加密（2026-09-19，E2E 快测通过）

- ✅ **`server/crypto.py`（新文件）**：`AGENT_SWARM_ENC_KEY` 设置即启用；子密钥 = sha256(服务器密钥+":"+用户apikey) 每用户独立；密文 `enc1:<fernet>`；`AGENT_SWARM_ENC_KEY_RECOVERY` 第二服务器密钥解密兜底（轮换场景：新主密钥+旧主密钥作恢复密钥）；`decrypt(key, enc, plain_fallback)` 统一读入口——密文缺失/坏/密钥不匹配回退明文列（密钥丢失=历史不可读但不崩）；未启用时全零行为变化
- ✅ **加密范围**：`workspaces.purpose/notes/session_title`、`a2a_tasks.message/artifact/error`、`a2a_events.payload`（thinking/tool/回答全在 payload 里）；写入密文列并**清空明文列**；模型加对应 `*_enc` 列 + `a2a_tasks/a2a_events.user_id`（密钥归属；db.py 自动迁移）
- ✅ **存量回填**（决策 a）：`init_db` 幂等回填——有密钥时把明文就地加密并清空明文列；外部任务（无属主）保持明文
- ✅ **写点改造**：nexus_a2a（任务/监控事件 payload、监控轮 message、artifact、错误文本、web 下发 `_new_task`、`_mark_task`）+ mcp_endpoint（workspace_add/update_info purpose、update_notes、heartbeat session_title、a2a_call 内外部任务、超时错误）
- ✅ **读点改造**（出参不变，web/feishu/admin 无感知）：`task_obj`（error 解密）、`event_payload_text`/`_apikeys_for_rows`（批量防 N+1）、SSE 回放、`/api/nexus` 历史与 rounds 分页、`/api/calls`（instruction/result/error）、`/api/workspaces` ws_out、admin workspaces（purpose/session_title）、mcp list/info/notes、feishu brief/perm_card/last（新增 `feishu/event_text.py` 共用解密）
- ✅ **apikey 重置联动**（决策 2）：`/api/me/apikey/reset` → `_reencrypt_user_rows` 全量解密→新 key 重加密（旧 key 解不开的行跳过不动）；admin 重置密码不动 apikey 无需处理
- ✅ **文档**：README/README_CN 配置表加 ENC_KEY/RECOVERY（明文默认、密钥丢失后果、备份要求）+ 回填/重置两条补充说明；web 文档页 FAQ 加「数据是明文存库的吗？」+ API Key 重置条目补重加密说明；AGENTS.md Server facts 加 Encryption at rest bullet；`.env.example` 新建（全部配置项 + 密钥生成命令）
- ✅ 验证：crypto 单测（加密/解密/错误密钥回退/恢复密钥轮换/未启用模式）+ 临时 DB E2E 六阶段（明文播种→启用回填→解密读回→密钥丢失回退→apikey 重置重加密→幂等重启）全部通过；所有 server py ast.parse 通过
- ⚠️ 真实服务（:8700，存量数据）尚未带密钥实测——用户启用时提醒：**先备份 `.env` 密钥再重启**

### 前台会话实时监控 nexus monitor（2026-09-15，已提交推送，E2E 全链路验证）

- ✅ **插件单管道**（`plugins/opencode/src/index.ts` 重构）：event hook 按 sessionID 分流——`a2aRuns` 命中 → A2A 任务事件（原路径不变）；否则前台会话 + `monitor` 开（默认开，每事件热重读配置）→ 监控上报。轮次生命周期：`message.updated`(role=user) 开轮（roundKey=`mon-<sid8>-<msgId12>`）→ parts 流式上报 → `session.idle` 关轮。中枢任务轮因 a2aRuns 命中走任务通道，监控通道自动静默（不重复上报）
- ✅ **`/swarm-monitor` TUI 命令**（tui.ts）：弹窗切开/关写配置即时生效；`config.ts` 加 `monitor` 字段默认 true
- ✅ **message.updated 无 parts 的坑**（SDK 类型如此）：先发空文本 user 事件开轮，300ms 后从 `session.messages` 补拉提问文本发 `user-text` 回填；用户消息自身的 text part 跳过（否则提问渲染成回答）
- ✅ **`nexus_a2a.ts`**：`sendMonitor`（`{"type":"monitor"}` 消息）复用断连缓冲（上限 2000）
- ✅ **服务端**（`nexus_a2a.py`）：`a2a_events` 加 `round_key` 列（自动迁移）；`handle_monitor_event` 落库 + 自动建/更新监控轮任务行（id=roundKey，caller="monitor"；permission/question→input-required、replied→working、idle→completed）；**input-required 期间尾部快照不把状态推回 working**（曾致 409 卡死）；reply 端点监控轮非终态即可应答（幂等容忍 TUI/web 竞态）；`subscribe` 回放只回最新一轮 + `first_id` 游标；`GET /api/nexus/{wid}/rounds?before_id=` 向上分页；`_push_web` 加 `type_` 参数（monitor 双层包装 bug 曾致实时流全灭——必须传 `type_="monitor"`）
- ✅ **web 中枢**：monitor 全类型事件渲染（user/thinking/tool/text/权限/提问/idle），权限条目远程应答（task_id=roundKey）；固定视口高度布局（页面无滚动条，timeline 内部滚动）；上滚分页重写为纯转换+前插（清空重放曾丢正在看的内容），视口位置补偿，游标来自 subscribe first_id；贴底自动跟随 + 悬浮"回到底部"按钮；clear 只清前端；**monitor 事件字段 camelCase（callId/partId/toolState）前端必须匹配**（snake_case 读法曾致 key 冲突整轮只显示最后一个工具）
- ✅ **调用记录页**：必选工作区筛选（nexus 同款自绘下拉 + cookie 记忆 30 天）；监控轮 `[monitor]` 徽标、双方=工作区自己；单条删除级联删事件；clear-all 一键清空（危险红 hover）
- ✅ **busy 按工作区隔离**：切工作区清 busy（曾致 B 区继承 A 区 working 态输入框锁死）；lastSentTask 改 Map<wid,taskId>；切回按 taskStates 恢复真实状态
- ✅ E2E 全链路验证：TUI 对话实时同步、中枢下发不重复、权限远程应答、上滚分页、调用记录、跨工作区 busy

### claude 后台会话骨架（2026-09-14 深夜2，已提交，问题已在 Linux 机修复 → 见 git log 71def2c/ea8fb7b/81c4ef9）

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

> 旧的"待办第 0 条（claude 后台会话问题修复）"已在 Linux 机完成（git log 71def2c strict-mcp-config / ea8fb7b input_json_delta+reaper / 81c4ef9 append mode），本节归档删除。

### 高优先级

- [ ] **桌宠对接 E2E 收尾**（2026-09-25 批次，服务端均已进 dev 并已在本机部署）：① 插件重装 + 重启 opencode 后验**接单即 ack**（长前台任务 plugin.log 无 "no ack in 30s"）；② 桌宠实测 **WS 通配订阅**：hello(apikey) → subscribe `{"workspace_id":"*"}` → 其它工作区事件实时到达、第二用户事件收不到；③ web 前端中枢页对 `subscribed` 回执 `workspace_id:"*"` 的兼容确认（web 不用通配，理论无影响）
- [ ] **重建镜像并部署**（把本轮所有服务端改动带上线）：多连接/去 4001 踢人、`with Session` 内不 await、SQLite WAL+池 30、`tasks/cancel` 与超时置 failed 漏 commit、`dispatchable` 离线派发策略 C，外加 V2 插件与按版本分流的安装脚本（tarball 由 start.sh 打包）、09-25 桌宠批次（双鉴权/派发可靠化/通配订阅）。推送 `10.17.17.19:8082/agent-swarm:latest` 后从 dpanel 更新
- [ ] **其它机器重装插件**：V1 机器走 V1 分支（逻辑未变）；V2 机器（如 4.193）重装后会自动发现 V2 插件。注意旧镜像 tarball 里没有 V2 插件，必须先重建镜像
- [x] **V2 权限应答 E2E**：2026-09-23 已通（web 下发 A2A 轮 → TUI 弹权限 → web 点 allow always → 任务放行写入成功，任务行 accepted_at/completed 正常）。顺带暴露并修复服务端 A2A 轮状态写回 bug（见架构演进史 09-23 条）。取消（`session.interrupt`）仍未验
- [ ] **V2 后台续聊 E2E**：同 caller 连发两单，确认第二单复用 `.agent_swarm/sessions.json` 的会话（plugin.log 见 resume）
- [ ] **V2 5 条命令交互验证**：`/swarm-mode`、`/swarm-monitor`、`/swarm-remove|enable|disable` 在 TUI 里真按一遍（目前只验证了加载与注册）
- [ ] **ps1 安装脚本 Windows 实测**：只做了 BOM/括号静态检查，未在 Windows 跑过 V2 分支
- [ ] **V2 提问（form）支持**：server 插件 ctx 无 `session.form`——先按兼容 bug 反馈 opencode，官方补上后接应答（当前只上报）

- [ ] **nexus-feishu**（下一个功能，用户已排期）：飞书渠道接入中枢，复用 A2A 下发/事件流/应答链路（caller=nexus-feishu）
- [ ] **后台会话续聊 E2E（opencode 侧）**：同 caller（如 nexus-web）连发两个任务，验证第二个任务复用 `.agent_swarm/sessions.json` 里记录的会话（plugin.log 应见 `resume ses_`），且对话上下文延续
- [ ] **后台任务独立会话在中枢页无区分展示**：后台任务（A2A-xxx 会话）与前台监控轮在时间线上无视觉区分；task 的 session_id 上报后工作区表"当前会话"列刷新未验证
- [ ] 真实 opencode 前台注入权限应答 E2E：web 下发 → TUI 前台注入 → 权限应答 → artifact 回传（**A2A 轮权限应答 2026-09-23 已验证通过**；剩余未验：提问 question/form 应答——V2 server 插件无 session.form 只上报，见上面 form 待办）

### 备忘

- [ ] a2a-inspector 互操作验证（规范符合性快检，可选）
- [ ] nas_brain 工作区 ID：CZBLEoPszNwLWpA2J4auGA（Windows 机 nas_brain 目录）；XYaR4TdtGqdqoAEW9vNn8g（Linux 机旧记录可能已失效，以 web 工作区页为准）
- [ ] npm install 慢（~40s）：可把 @opencode-ai/* 设为 peerDependencies
- [ ] 微信产物文件 item（iLink type-2）真机渲染未验证：`server/weixin/file_push.py` 目前走官方文件 item，失败降级文本链接——真机发一个产物确认普通微信客户端能收文件
- [ ] teams 表清理（确认永不恢复后删）
- [ ] 前端 lint 有两个既存 warning（set-state-in-effect），非阻塞
- [ ] 前端 lint 有一个既存 warning（WorkspacesPage set-state-in-effect），非阻塞

## 环境/常用操作（Linux 开发机 2026-09-23 起）

```bash
./deploy/start.sh            # 本机起服务（:8700；会重打 plugins/ -> data/agent-swarm-plugin.tar.gz）
./deploy/stop.sh
cd web && npm run build       # 产物由 8700 托管
cd web && npm run dev         # dev :8701
cd plugins/opencode && npx tsc --noEmit   # 插件类型检查
# 改了 plugins/opencode/src/ 后在 V2 本机生效（V2 自动发现安装目录）：
# 1. cp 改动的文件到 ~/.config/opencode/plugins/agent-swarm/{index.ts,tui.ts,src/...}
# 2. touch ~/.config/opencode/plugins/agent-swarm/index.ts   # 触发 service 热重载
#    （V2 插件由 service 加载，改完不必重启 TUI；V1 才需要重启 opencode）
# 3. 看日志确认：~/.config/opencode/plugins/agent-swarm/plugin.log 出现 v2 start
```

- 线上服务：`10.17.17.19:8700`（容器 `agent-swarm`），`sshpass -p centerm ssh wangxu@10.17.17.19`，日志 `docker logs agent-swarm --timestamps`；**容器内代码即镜像 `/app`，改 server/ 必须重建镜像**（`./deploy/build_docker.sh 10.17.17.19:8082/agent-swarm:latest && docker push …`；8082 是 registry-ui 反代到 5000，同一后端）
- 本机 opencode：**v2.0.15**（npm `@opencode/cli`）；V1 是 `opencode-ai`。安装目录 `~/.config/opencode/plugins/agent-swarm/`（V2 自动发现 `index.ts`+`tui.ts`，**不需要 node_modules**）
- 插件配置：`~/.config/opencode/agent-swarm.json`（serverUrl+apiKey+executionMode+monitor）；opencode 全局配置 `~/.config/opencode/opencode.jsonc`（V2 不再需要写 agent-swarm 的 `plugins` 条目）
- opencode 运行日志：`~/.local/share/opencode/log/opencode.log`（插件加载失败看这里：`grep "loading plugin\|failed to load plugin"`）
- 心跳 30s，90s 超时判离线；**时间戳全是 UTC**，用户在 UTC+8（反复踩过，AGENTS.md 有记载）

## 环境/常用操作（Windows 本机，历史存档）

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
- 快捷排查：`Select-String -Path "$env:USERPROFILE\.config\opencode\plugins\agent-swarm\plugin.log" -Pattern "background|a2a|monitor" | Select-Object -Last 20`；claude 侧 `Get-Content "$env:USERPROFILE\.claude\agent-swarm\keepalive.log" -Tail 40`
