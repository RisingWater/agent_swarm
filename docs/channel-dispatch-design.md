# 即时渠道消息分发设计：飞书 / 微信 ClawBot 的详细流与简报

> 版本: v2 · 日期: 2026-09-20 · 状态: **已实现并真机 E2E 验证**（v1 微信侧方案 2026-09-19 落地；2026-09-20 补充跨渠道权限/提问四方先答先算）
> 背景：微信 ClawBot 渠道（`server/weixin/`）首版把"简报"和"详细流"的关系做反了——微信自己派的任务本应有详细流（thinking/tool/回答/提问/权限），却只发了终态简报；监控轮又被一刀切跳过简报。本文档统一两个渠道的分发模型，作为改造依据。

## 1. 核心模型

一次任务/对话轮（调用记录）在即时渠道的呈现分两类：

| 呈现 | 内容 | 渠道形态 |
|---|---|---|
| **详细流** | thinking / tool call / assistant 文本 / 提问 / 权限请求 | 飞书：timeline 时间线多卡（CardKit 流式）<br>微信：纯文本序列（💭 前缀 + 🔧 文本行或官方 tool item） |
| **简报** | 指令首行 + 最终回答（或失败原因）的单条摘要 | 飞书：单卡<br>微信：Markdown 文本 |

**分发判定总规则**（一个事件落库后依序执行）：

1. **详细流判定**：该事件是否要推详细流到某渠道？
   - 飞书：`feishu_chats` 中**选中该工作区且 monitor_on** 的窗口（监控流）；或该任务是**飞书自己派发的**（caller=`nexus-feishu`，timeline 全程卡）
   - 微信：该任务是**微信自己派发的**（caller=`nexus-weixin-clawbot`）→ 必推详细流；或该工作区 `monitor_on` 且微信在线（监控流）
   - web：无条件通知刷新（`_push_web`）
2. **调用记录完成判定**：该事件是否使某条调用记录进入终态（completed / failed）？idle 收尾、被新轮顶替（superseded）都会导致完成。
3. **简报判定**（对每条完成的调用记录）：
   - **若该任务的详细流已经推送给过这个微信/这个飞书窗口 → 不发简报**（判定依据见 §3 去重规则）
   - 否则：属主用户名下 `brief_on` 的窗口/微信收简报
4. **提问/权限请求**：与详细流同路（详细流开着就随流推卡片/文本选项；未开详细流的渠道按简报规则推单卡提醒）。

## 2. 事件源与广播机制（现状，不改）

所有事件汇入 `nexus_a2a.internal_listeners`（进程内同步调用，逐监听器 try/except）：

| 事件 | 形状 | 广播点 |
|---|---|---|
| A2A 任务事件 | `{kind: "status-update"/"artifact-update", taskId, status, artifact, metadata}` | `handle_plugin_event` |
| 监控轮事件 | `{roundKey, type: user/user-text/reasoning/tool/text/permission/question/replied/idle, ...}`（**无 kind**） | `handle_monitor_event` |
| 监控轮完成 | 同上 `type=idle` | 同上（**无合成的 status-update**——各渠道要自己处理 idle） |
| 被顶替的旧轮 | 合成 `{kind: "status-update", status: {state: "completed", superseded: true}}` | 同上 |

## 3. 飞书侧逻辑（现状梳理，作为参照实现）

### 3.1 详细流（`feishu/bridge.py`）

**A2A 任务（只处理自己派的）**：`_on_task_event` → 查任务行，`caller != "nexus-feishu"` 直接 return。派发窗口的 timeline 卡（RoundCards：用户卡 → 💭 思考 → 🔧 工具（每 callId 一行）→ ✅ 最终回答），`input-required` 原地插按钮组。

**监控轮（monitor_on 开关）**：`_on_monitor_event` → `chats_watching_workspace(workspace_id)`（选中 + monitor_on 过滤）逐窗口 RoundCards 同步；`user` 事件开占位卡（user-text ~300ms 后补文本）；`idle` → `finalize("completed", pending_final_text)`。**监控轮完成后不发简报**——timeline 已是全程详情。

### 3.2 简报（`feishu/brief.py`）

- 触发：`kind=status-update` 终态，**或** `type=idle`（监控轮，completed 补抓）
- **去重（免发规则）**：
  - `caller == "nexus-feishu"` → return（timeline 全程已覆盖）
  - 监控轮（caller=monitor）：`monitor_on` 且选中该工作区的窗口已在排除集 `exclude`，其余 `brief_on` 窗口仍收简报
- 收件人：**任务属主名下**所有 `brief_on` 窗口（`brief_chats_all(owner, exclude)`，不按选中工作区限定，避免跨用户泄漏是靠 owner 过滤）
- 权限/提问卡（`perm_card.py`）：无条件推属主名下窗口（不等简报），`input-required` 时推、应答后收尾卡

### 3.3 飞书侧与目标模型的差距（微调项）

| # | 差距 | 修改 |
|---|---|---|
| F1 | 监控轮简报排除逻辑依赖"选中该工作区"的窗口排除集；若用户 monitor_on 开了但**选中别的窗口**，会重复收（详细流+简报都有） | 可接受（窗口选中语义如此），不改；如需严格，`exclude` 补充 `chats_watching_workspace` 全集 |
| F2 | `brief.py` 的 idle 分支对监控轮 artifact 为空时仍会发"（无最终回答文本）"卡 | **改**：artifact 为空的监控轮跳过简报（对齐微信侧新规则） |

## 4. 微信侧改造方案（`server/weixin/`，本文档主目标）

### 4.1 详细流（新增，`bridge.py`）

`_route` 收到 A2A 任务事件时查任务行：

```
caller == "nexus-weixin-clawbot" 且属主微信会话在线（sess.context_token 非空）
  → 必推详细流（等价于"飞书自己派的任务走 timeline"），事件映射：

  metadata.nexus == "reasoning"      → 💭 {text}（纯文本，800 字截断）
  metadata.nexus == "tool"           → 官方 tool item（type 11 start / 12 result）
                                        发送失败降级文本行 🔧 {tool} …/✓/✗
                                        节流：同一 (round, callId, state) 只发一次
  metadata.nexus == "text"           → 缓存 pending_final_text（replace/append 语义），
                                        【不】随流发——最终回答由 completed 时一次性发全量
                                        （微信无流式卡片，逐段发会碎片刷屏；用户已拒绝 GENERATING 打字机）
  state == "input-required"          → 权限/提问文本卡 + 入 pending（现有 _push_input_required 复用）
  state == "failed"                  → ❌ 失败原因文本
  state == "completed"               → 发最终回答全量（pending_final_text 或 artifact），
                                        清 pending，【不】发简报（详细流已覆盖）
```

注意：A2A 任务的 thinking/tool 标签在 `event.metadata.nexus`（camelCase：partId/callId/toolState/tool/input/output——与 web `applyA2aEvent` 同构，参照 `feishu/bridge.py:_apply_task_event` 的取法）。

### 4.2 监控流（现有，保留）

`monitor_on=1` 的微信用户收到其**选中工作区**的监控轮事件：`reasoning` → 💭 文本；`tool` → 官方 item/文本降级（节流）；`text` → 不发（回答由 idle 简报兜底）。前提校验（`sess.context_token` 非空）保留。

### 4.3 简报（`_brief_round`，按来源分流）

| 任务来源 | 终态时 | 依据 |
|---|---|---|
| `caller=nexus-weixin-clawbot` | **永不发简报** | 详细流已全程推送到该微信（§4.1） |
| `caller=monitor`（TUI 轮） | artifact **非空**才发 | 有回答值得收；tool-only 空轮静默防刷屏 |
| 其它（web / 飞书 / agent 互调 / A2A 外部） | 发（`brief_on` 前提下） | 该微信没有收到过这些任务的详细流 |

公共规则：`brief_on=0` 不发；`sess.context_token` 为空（用户久未在微信发言）推不出去，仅记日志；input-required 的 pending 随终态清理。

### 4.4 提问/权限请求

- 微信自己派的任务：详细流内推编号选项文本卡（§4.1 input-required），回复路由到 pending（现有）
- 其它来源（web/飞书/agent 派的任务在执行中要授权）：按简报规则推单条权限/提问文本卡（现有 `_push_input_required`，保持"非微信来源"前提）

### 4.5 渠道间去重原则

**一个任务对同一个微信用户：详细流与简报互斥。** 判定用 `task.caller` 即可（caller 编码了来源渠道），无需新增标记表：
`nexus-weixin-clawbot` ⇒ 发过详细流 ⇒ 免简报；其余 caller ⇒ 未发过 ⇒ 发简报。
（飞书侧同理由 `nexus-feishu` 判定，现状已如此。）

## 4.6 跨渠道权限/提问四方先答先算（2026-09-20 用户拍板）

TUI 前台会话（监控轮）拉起 permission/question 时，按简报开关（brief_on）广播到**所有** nexus 渠道：web（原生）、飞书、微信；四方（TUI 本地 / web / 飞书 / 微信）谁先应答谁生效，任务翻出 input-required，其它渠道后续应答干净失败。

- **插件**（`plugins/opencode/src/index.ts`）：权限/提问**按 request id 去重**上报——`a2aInputSeen`（A2A 轮）与按轮的 `inputSeen` Set（监控轮）。permission 事件无 `title`，**具体路径/命令在 `patterns[]`**（EventPermissionAsked），A2A 与监控轮 payload 都带上；渠道卡显示 `访问/执行：<patterns>`，无 patterns 才兜底轮首指令。渠道应答（replied 事件）清监控轮 `inputState`。
- **服务端**：
  - `feishu/perm_card.py`：`_on_event` 接收**无 kind 的扁平 monitor payload**（`from_monitor=True`，绕过 caller 排除），`_input_data` 回退扁平形状；task_id=roundKey，复用 web 同款应答端点
  - `weixin/bridge.py`：monitor 分支 `permission/question` → `_push_monitor_input_required`（brief_on 门槛 + `state.set_pending(..., request_id)` + 编号卡），`replied` → `state.pop_pending_task(round_key)`,working 转移也清理 pending
  - `nexus_a2a.py::_input_type`：兼容扁平 payload（顶层 type）——监控轮 question 才不会被误判为 permission
- **应答端点统一**：监控轮任务行 id=roundKey（caller=monitor），`reply_task_from_feishu(task_id=roundKey, requestId)` 服务所有渠道；`state.set_pending` 存**真实 permissionId**（request_id 参数），假 id 曾致 TUI 弹窗挂到超时（2026-09-20 bug）。
- **微信应答语义**（用户拍板）：pending 期间**任何非空输入**（含 `/q`）都是应答，菜单规则不得盖过；permission 只认编号 1/2/3 → once/always/reject，其它一律 once。

## 5. 修改清单（均已实现，2026-09-19~20）

| 文件 | 改动 |
|---|---|
| `server/weixin/bridge.py` | `_route` A2A 事件按 caller 分流：`nexus-weixin-clawbot` → `_stream_task_event`；终态统一 `_brief_round` + 微信来源免简报；monitor 分支新增 permission/question → `_push_monitor_input_required`、replied → `pop_pending_task`（§4.6）；working 转移清 pending |
| `server/weixin/render.py` | `assistant_final(text)`（最终回答全量）；`task_accepted_text`（受理回执，2026-09-20 去掉任务 ID 前缀）；permission 编号卡固定三选项 |
| `server/weixin/commands.py` | pending 应答顶级优先（步骤 0，任何非空输入含 /q）；菜单只认斜杠+编号；`_answer_pending` 回传真实 request_id |
| `server/weixin/state.py` | `set_pending(..., request_id="")`、`pop_pending_task(task_id)` |
| `server/feishu/brief.py` | F2：idle 补抓的监控轮 artifact 为空时跳过 |
| `server/feishu/perm_card.py` | 接收无 kind 扁平 monitor payload（`from_monitor=True`），`_input_data` 扁平回退（§4.6） |
| `server/nexus_a2a.py` | `_input_type` 兼容扁平 payload 顶层 type（§4.6） |
| `plugins/opencode/src/index.ts` | 权限/提问按 request id 去重（`inputSeen`/`a2aInputSeen`）；payload 带 `patterns[]`；渠道应答清监控轮 inputState |
| `TODO.md` / `AGENTS.md` | 记录分发模型 + 跨渠道应答（引本文档） |

## 6. 验收清单（真机，2026-09-20 全过）

- [x] 微信派任务 → 微信收到：受理回执 → 💭 thinking → 🔧 工具行 → 最终回答全量 → **无简报**
- [x] 微信派任务执行中触发权限/提问 → 微信收编号选项卡（显示 `访问/执行：<patterns>`）→ 回复编号 → 任务继续
- [x] TUI 轮（monitor_on 开）→ 微信收 💭/🔧 详细流 → idle 后收简报（有回答时）
- [x] TUI tool-only 轮 → 微信静默
- [x] web 派任务 → 微信（brief_on）收简报；微信派同工作区任务不受影响
- [x] 飞书 timeline（飞书派任务）/简报（其它来源）/监控流（monitor_on）行为不回归
- [x] **跨渠道四方先答先算（§4.6）**：TUI 触发权限 → web/飞书/微信同时收卡 → 任一方应答 → 任务翻回 working，其它渠道后续应答干净失败
- [x] 同轮内第二个权限（新 request id）正常上报（reject/应答后不吞）
- [~] `data/weixin.log`：排查期日志保留有用（wx-route/wx-monitor/weixin reply 全链路）；`_setup_debug_log` 是否移除待定（保留便于后续渠道排障）
