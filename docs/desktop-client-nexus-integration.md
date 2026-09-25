# 外部客户端（桌宠类 Python 程序）对接 nexus 接口设计

> 版本: v2 · 日期: 2026-09-25 · 状态: **v1 的可选扩展已全部落地（§9 → 已实现清单见 §9.1）**；新增 WS hello apikey 双鉴权、reply/history/rounds 双鉴权、subscribe 通配 `"*"`、终态帧 brief 摘要、a2a_call 禁止自我派单
> 背景：希望有一个常驻 Python 程序（例如桌宠）登录 nexus，按**简报模式**收 permission/question 提醒并代为应答。本文档给出推荐的接口组合、消息形状与注意事项，作为桌宠侧开发依据。

## 1. 结论

**不发明新接口**：桌宠本质是"一个没有浏览器的 web 客户端"，直接复用 web 中枢的三件套——

| 用途 | 接口 | 鉴权 | 位置 |
|---|---|---|---|
| 登录拿凭证 | `POST /api/auth/login` | 用户名/密码 | `server/api/auth.py:53` |
| 订阅事件流（推） | **WS** `/ws/nexus` | JWT **或 apikey**（hello 帧二选一，2026-09-25 起） | `server/nexus_a2a.py:1758` |
| 应答权限/提问 | `POST /api/nexus/{wid}/reply` | JWT **或 apikey**（Bearer，`_require_user_http`） | `server/nexus_a2a.py:~1204` |
| 断线补读 | `GET /api/nexus/{wid}/history`、`GET /api/nexus/{wid}/rounds` | JWT **或 apikey** | `nexus_a2a.py:~1384 / ~1676` |
| 下发任务（可选） | `POST /api/nexus/{wid}/message:send` | JWT（保持 JWT-only） | `nexus_a2a.py:~1175` |

为什么是 WS 而不是别的形态：权限/提问是**服务端主动推**的交互事件（推不回来桌宠就不知道该弹窗），且桌宠常驻在线——这正是 `/ws/nexus` 的模型。备选形态的否决理由见 §8。

## 2. 登录与鉴权

```http
POST /api/auth/login
{"username": "...", "password": "..."}
→ {"token": "<JWT>", "user": {...}}
```

- JWT 有效期 **24h**（`server/auth.py:13 JWT_EXPIRE_HOURS=24`），桌宠需在过期前重新登录（过期表现：WS `hello_err`、REST 401）。
- **apikey 双鉴权（2026-09-25 落地，v1 的 §9 扩展一）**：WS hello 与 reply/history/rounds 三组 REST 均**接受 apikey 长效凭证**（账号页「API Key」），与 JWT 二选一：
  - WS：`→ {"type": "hello", "apikey": "as_..."}`（有 apikey 走 apikey，否则回退 token/JWT）
  - REST：`Authorization: Bearer <JWT 或 as_ 开头的 apikey>`（`get_user_either`/`_require_user_http`）
  - **推荐桌宠直接用 apikey**：长驻进程免 24h 重登录；apikey 在账号页可重置（重置后旧 key 立即失效）。
- `POST /api/nexus/{wid}/message:send` 与清空历史 `DELETE /api/nexus/{wid}/history` **保持 JWT-only**（最小改动决策，2026-09-25）。

## 3. WS 订阅协议（`/ws/nexus`）

### 3.1 握手时序

```jsonc
→ {"type": "hello", "apikey": "as_..."}     // 或 {"type":"hello","token":"<JWT>"}（二选一）
← {"type": "hello_ok"}                      // 或 {"type":"hello_err","error":...}
→ {"type": "subscribe", "workspace_id": "<wid>"}   // 或 "*" 通配（见下）
← {"type": "subscribed", "workspace_id": "<wid>",
   "plugin_online": true,                  // dispatchable(wid)：能否下发任务
   "history": [...],                       // 最新一轮事件回放（含 A2A + monitor 混合）
   "first_id": 1234}                       // 上滚分页游标（配 /rounds?before_id=）
← {"type": "event",   "payload": {...}}    // 实时推送（此后持续）
← {"type": "monitor", "payload": {...}}
← {"type": "task",    "task": {...}}       // 任务快照（状态变化/终态/应答自持后）
→ {"type": "ping"}  ← {"type": "pong"}     // 保活
```

- **一条连接只订阅一个目标**：精确 wid，或（2026-09-25 起）通配 `"*"`（subscribe 前先退订旧的）。桌宠想盯多个工作区，一条通配连接即可，不必开 N 条。
- **通配订阅 `{"workspace_id": "*"}`**（2026-09-25 落地）：
  - 语义 = 订阅**本用户名下全部工作区**，与飞书/微信「属主全局」简报一致；服务端逐事件按 `_owns(user_id, wid)` 属主过滤，**别人的工作区事件推不到你**。
  - 回执：`{"type":"subscribed","workspace_id":"*","plugin_online":<名下任一可派发>,"history":[],"first_id":0,"note":"replay skipped for wildcard"}`
  - **不做 history 回放**（N 个工作区大 payload）：桌宠上线从当下开始听，历史需要时走 REST `/history` / `/rounds` 自行补。
  - 推送内容与精确订阅**完全一致**（event/monitor/task 三种帧 + 终态 brief 摘要，monitor 也在内）。
- 工作区必须属于当前用户（`_owns` 校验），否则 `subscribed` 带 `error: "no permission"`。
- 重连后重新 hello + subscribe 即可；精确订阅**自带最新一轮回放**，离线期间的 input-required 不会丢（通配无回放，见上）。

### 3.2 事件形状（桌宠要解析的两类）

**① A2A 任务事件**（`type: "event"`，`payload.kind = "status-update" | "artifact-update"`）——permission/question 藏在 `input-required` 状态的 DataPart 里（web 同款解析见 `web/src/App.tsx:2330`）：

```jsonc
{
  "kind": "status-update",
  "taskId": "9NbRZFgs...",
  "status": {
    "state": "input-required",
    "message": {
      "role": "assistant",
      "parts": [
        { "kind": "data", "data": {
            "type": "permission",        // 或 "question"
            "requestId": "perm_xxx",     // 应答时原样带回
            "title": "...",              // permission：说明（可能缺省）
            "permission": "...",         // permission：权限类别
            "patterns": ["D:\\path\\.."],// permission：具体路径/命令（无 title 时的真信息）
            "question": "...",           // question：问题文本
            "options": [{"label": "...", "value": "..."}]  // question：选项
        }}
      ]
    }
  },
  "metadata": { "nexus": "..." }          // text/reasoning/tool 细节标注（简报模式可忽略）
}
```

**② 前台监控轮事件**（`type: "monitor"`，**扁平形状、无 kind**）——字段在顶层（`App.tsx:2390`）：

```jsonc
{ "roundKey": "mon-xxxx-xxxx",   // 监控轮的 task_id 就是 roundKey
  "type": "permission",          // 或 "question" / "replied" / "idle" / "text" / "tool" ...
  "requestId": "...", "title": "...", "permission": "...", "patterns": [...],
  "question": "...", "options": [...] }
```

**③ 任务快照**（`type: "task"`）：`{"task": {"id", "status", ...}}`——桌宠用它刷新状态、判断某权限是否已被他人应答。

**④ 终态简报摘要 `payload.brief`（2026-09-25 新增，桌宠简报卡数据源）**：A2A 任务到终态时，completed 帧带 `brief.artifact`（最终回答明文，截 1600）、failed 帧带 `brief.error`（失败原因，截 700）；监控轮 `idle` 帧带 `brief.artifact`。只拼在 WS 推送的内存副本上（落库/回放无此字段，历史需自行解密）。**桌宠简报正文直接取它，不必自己解析 artifact parts**——与飞书简报卡（回答截 1500 / 失败截 600）同源。

> 去重键 = `requestId`（与 web 权限卡 `perm-${requestId}` 同规则）。**同一轮内第二个权限是新的 requestId**，不可按"轮"去重。

### 3.3 简报模式（客户端过滤，零服务端改动）

飞书/微信的简报是服务端推的，因为 IM 是"不常连"通道；桌宠常连 WS，自己过滤即可：

| 收到什么 | 桌宠做什么 |
|---|---|
| `input-required`（event/monitor）且 requestId 未应答 | **弹权限/提问气泡** |
| `type:"task"` 或 status 终态（completed/failed/canceled） | **播报一句简报**（指令首行 + 最终回答/失败原因） |
| `replied`（monitor）/ 应答后自持的 `working` | 收起气泡 |
| text/reasoning/tool 流式帧、artifact 全量 | **忽略**（简报模式不渲染详情流） |

artifact（最终回答全量）在 `payload.artifact.parts[].text`（A2A）——简报正文取它；监控轮的回答在 `idle` 前的 `text` 事件/回放里。

## 4. 应答（REST）

```http
POST /api/nexus/{workspace_id}/reply
Authorization: Bearer <JWT>

// 权限
{"task_id": "...", "type": "permission", "request_id": "<requestId>",
 "reply": "once" | "always" | "reject"}

// 提问（answers 为非空二维数组，web 同款 string[][]）
{"task_id": "...", "type": "question", "request_id": "<requestId>",
 "answers": [["选项文本"]]}
```

- **监控轮的 `task_id` = `roundKey`**（caller=monitor 的任务行 id 就是它），A2A 轮 = `taskId`——从事件里取哪个字段就用哪个，端点本身不区分。
- 成功：`200 {"ok": true, "status": "working"}`；服务端随即**自持 `input-required → working`** 并推 `{"type":"task"}` 快照（2026-09-23 修复）——桌宠收到该快照即可收起气泡。
- **409 = 先答先算（first-answer-wins）**：`task is working/completed..., not waiting for input` 说明 TUI/web/飞书/微信（现在是五方）里已有人先答——**不是错误**，桌宠应丢弃本地气泡并刷新状态即可。
- 其它错误：`409 workspace plugin is not online`（插件离线，稍后重试或放弃）、`404/403`（任务不存在/非本人）、`422`（字段缺失）、`502 plugin connection lost`（转发瞬断）。
- 监控轮应答校验宽松（未终态即接受，`nexus_a2a.py:1222`），A2A 轮严格要求 `input-required`（1225 行）。

## 5. 断线补读

| 场景 | 手段 |
|---|---|
| 短暂断线重连 | 重新 hello + subscribe，`subscribed.history` 回放最新一轮 |
| 想知道更早的轮 | `GET /api/nexus/{wid}/rounds?before_id=<first_id>`（每轮全部事件，`{events, first_id, has_more}`） |
| 全量回放 | `GET /api/nexus/{wid}/history?limit=800` |

**回放重放注意**：回放里可能包含"离线期间已弹过且已被应答"的 input-required——重建待答集合时要顺着回放看到后续 `replied`/`working`/终态就把该 requestId 标记为已答，不要重新弹一遍。

## 6. 下发任务（可选，桌宠主动唤起 agent）

```http
POST /api/nexus/{workspace_id}/message:send
{"text": "帮我看下 ...", "task_id": "<可选，续聊用>", "context_id": "<可选>"}
→ 任务快照 {id, status: "queued", ...}
```

- `409 workspace plugin is not online` = 工作区不可派发（没开 TUI 且非后台模式，策略 C）。
- 续聊：同 caller 连发带相同 `task_id`/`context_id` 可复用会话（后台续聊语义）。

## 7. 与其它渠道的关系

- **先答先算不变**：TUI / web / 飞书 / 微信 / 桌宠，谁先应答谁生效，其余渠道（含桌宠）后续应答干净 409——语义见 `docs/channel-dispatch-design.md` §4.6。
- **不冲突**：桌宠只是多一个 `/ws/nexus` 订阅者 + REST 调用方；飞书/微信是服务端进程内消费者（`internal_listeners`），两者不同路、互不影响。
- 简报开关 `brief_on` 是**飞书/微信渠道自己的**（`feishu_chats`/微信 ws 设置），桌宠的简报开关应放在桌宠本地配置里，不需要动服务端。

## 8. 备选形态与否决理由

| 形态 | 结论 | 理由 |
|---|---|---|
| **WS `/ws/nexus` + REST reply（推荐）** | ✅ | 服务端主动推、多订阅者、web 已验证的同一条链路 |
| MCP 工具 | ❌ | stateless Streamable HTTP，**没有服务端推送**——权限来了桌宠不知道 |
| 轮询 `tasks/get`/`a2a_task` | ❌ | 有延迟、要先有 task_id、权限交互场景浪费请求 |
| 外部 A2A（`/a2a/{wid}` + `message/stream` SSE + apikey） | ⚠️ 备胎 | 鉴权天然长效，但作用域是**自己下发的那个任务**；桌宠要"谁的任务弹权限我都弹"是 workspace 级订阅，那是 `/ws/nexus` 的地盘 |

## 9. 可选服务端小扩展（v1 时提出）——**已全部落地（2026-09-25 批次）**

### 9.1 已实现清单

1. **WS `hello` 支持 apikey** ✅（§2）：`{"type":"hello","apikey":"..."}` 与 token 二选一；reply/history/rounds 三组 REST 同步支持 `Bearer <apikey>`。
2. **subscribe 通配 `"*"`** ✅（§3.1）：本用户全部工作区订阅，属主过滤保留；v1 未预想的补充——**不做 history 回放**（回执 `note:"replay skipped for wildcard"`，历史走 REST）。
3. **终态帧 brief 摘要** ✅（§3.2 ④）：completed/failed/idle 帧带 `payload.brief`（artifact 截 1600 / error 截 700），桌宠简报卡免解析。v1 §9 未列出，实际按桌宠需求追加（派单 5pbzfAjo）。
4. **a2a_call 禁止自我派单** ✅（2026-09-25）：`target == from_workspace` 直接拒绝（"self-call loop"），防 agent 互调死循环；工具 docstring 同步声明。
5. **MCP 工具 annotation hints** ✅：12 个工具全部声明四 hint（readOnly/destructive/idempotent/openWorld），OpenAI 等目录校验要求。

### 9.2 未实现（按需再提）

1. **subscribe 带 `{"brief": true}` 过滤**：`_push_web` 出口只放行 input-required + 终态 + task 快照，省掉 text/tool 流量；桌宠侧不做过滤也能用（§3.3），仅是优化，暂无需求压力。
2. ~~WS hello apikey~~（已做，见上）。

## 10. 桌宠侧参考骨架（Python）

```python
import asyncio, json, httpx, websockets

SERVER = "http://10.17.17.19:8700"
WID = "<workspace_id>"   # 或用通配：SUBSCRIBE = "*"（订阅名下全部工作区，无回放）
APIKEY = "as_..."        # 推荐：长效凭证免 24h 重登录（v2 起 WS/REST 通用）

async def main():
    async with httpx.AsyncClient() as http:
        tok = (await http.post(f"{SERVER}/api/auth/login",
              json={"username": "u", "password": "p"})).json()["token"]
        # 用 apikey 时无需登录：headers={"Authorization": f"Bearer {APIKEY}"} 直接调 REST

    async with websockets.connect(f"{SERVER.replace('http','ws')}/ws/nexus") as ws:
        # hello：apikey 或 token 二选一
        await ws.send(json.dumps({"type": "hello", "apikey": APIKEY}))
        print(ws.recv())  # hello_ok
        await ws.send(json.dumps({"type": "subscribe", "workspace_id": WID}))
        # 通配订阅则: {"workspace_id": "*"} → 回执 history=[] + note（无回放）
        print(ws.recv())  # subscribed（含最新轮回放）
        pending = {}  # requestId -> 气泡
        async for raw in ws:
            msg = json.loads(raw)
            if msg["type"] == "event":
                p = msg["payload"]
                if p.get("kind") == "status-update":
                    st = (p.get("status") or {}).get("state")
                    if st == "input-required":
                        data = next((x.get("data") for x in
                                     (p["status"]["message"].get("parts") or [])
                                     if x.get("kind") == "data"), None)
                        if data and data.get("requestId") not in pending:
                            pending[data["requestId"]] = data
                            pet_bubble(data)          # 弹气泡
                    elif st in ("completed", "failed", "canceled"):
                        # v2：终态帧带 brief.artifact / brief.error（明文摘要），
                        # 简报直接用；旧逻辑（解析 artifact parts）仅作回退
                        pet_brief(p, st, brief=p.get("brief"))
            elif msg["type"] == "monitor":
                p = msg["payload"]
                if p.get("type") in ("permission", "question") \
                   and p.get("requestId") not in pending:
                    pending[p["requestId"]] = p
                    pet_bubble(p)                     # 监控轮：task_id = roundKey
                elif p.get("type") == "replied":
                    pending.pop(p.get("requestId"), None); pet_dismiss(...)
            elif msg["type"] == "task" and msg["task"].get("status") != "input-required":
                ...  # 快照：状态刷新 / 他人已应答时收气泡

# 应答（用户在桌宠上点了"始终允许"）
async def answer(http, task_id, req, kind="permission", reply="always"):
    body = {"task_id": task_id, "type": kind, "request_id": req}
    body |= ({"reply": reply} if kind == "permission" else {"answers": [["选项"]]})
    r = await http.post(f"{SERVER}/api/nexus/{WID}/reply", json=body,
                        headers={"Authorization": f"Bearer {tok}"})
    if r.status_code == 409:
        pet_dismiss(req)   # 先答先算：别处已应答，收气泡即可
```

## 11. 验收清单（桌宠首版）

- [ ] hello（**apikey**）→ subscribe → 收 `subscribed`（含最新轮回放）与实时 `event`/`monitor`/`task`
- [ ] **通配订阅 `*`**：另一工作区任务到终态 → 通配连接收到帧（含 `brief`）；第二个用户的事件收不到（属主隔离）
- [ ] A2A 轮弹权限 → 桌宠应答 → 200 → 收到 task 快照 → 任务继续
- [ ] 监控轮弹权限（task_id=roundKey）→ 桌宠应答 → 同上
- [ ] 五方先答先算：web 先答，桌宠后答得 409 并收气泡
- [ ] 断线重连：精确订阅离线期间被应答的 input-required 不重复弹（通配无回放，靠 REST 补）
- [ ] 简报：终态出摘要（直接取 `payload.brief`）；text/tool 流不打扰
