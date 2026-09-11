# agent_swarm 需求文档

> 版本: v0.1 (第一版) · 日期: 2026-09-11

## 1. 项目概述

agent_swarm 是一个多 agent 协作通信平台，让多个 opencode agent（AI 编程助手）能够：

1. **注册**：将自身工作区（工作目录 + 用途 + 能力）注册到中央服务
2. **可见**：用户通过 Web 管理页面查看自己/团队所有 agent 工作区的状态
3. **互助**：agent 之间可以互相求助（询问实现细节、帮忙改代码等）
4. **管理**：用户可以删除离线工作区、禁用/启用工作区

### 核心组件

| 组件 | 技术栈 | 说明 |
|------|--------|------|
| MCP Server + 管理后端 | Python (FastAPI)，单服务 | `/mcp` 端点服务 agent，`/api` 端点服务管理页面 |
| 管理前端 | React + Antd + Vite + TS | 用户/团队/工作区管理 |
| opencode 插件 | TypeScript (tsx) | 注册工作区、注入工具、执行求助任务 |

### 基础设施

- 数据库：SQLite（第一版）
- 服务端口：8700（可配置）

---

## 2. 架构设计（已确认决策）

### 2.1 单服务架构

```
FastAPI (uvicorn 单进程, :8700)
├── /mcp        MCP Streamable HTTP 端点 —— agent/plugin 调用（apikey 鉴权）
├── /api/...    管理后端 REST API —— Web 页面调用（JWT 鉴权）
└── SQLite (data/agent_swarm.db)
    ├── users
    ├── workspaces
    └── help_requests
    （teams / team_members 表结构保留在 models.py 中备用，功能暂未启用）
```

### 2.2 鉴权体系（所有 /mcp 请求强制 apikey 校验）

**MCP 端点 `/mcp`**：
- 每个请求（含初始化握手、tools/list、tools/call）都经过 FastAPI 依赖注入统一拦截
- Header: `Authorization: Bearer <apikey>`
- 无效 apikey → 401
- apikey → user 身份绑定，工具调用自动携带身份上下文：
  - `register_workspace` → 工作区归属当前 user
  - `list_workspaces` → 只返回自己 + 所在 team 的工作区
  - `poll_help_requests` → 只领到指向自己 workspace 的求助
  - `submit_help_result` → 只能提交指向自己 workspace 的任务结果
- apikey 服务端存 sha256 哈希，校验用 `hmac.compare_digest` 常量时间比较

**管理 API `/api`**：
- `/api/auth/register`、`/api/auth/login` 开放
- 其余接口 Header: `Authorization: Bearer <JWT>`（登录签发，24h 过期）
- apikey 查看/重置走 JWT 保护的管理接口

### 2.3 帮助请求异步模式

- 请求方调用 `request_help` 后立即返回 `request_id`
- 目标端 plugin 轮询领任务 → 执行 → 回写结果
- 请求方轮询 `get_help_result` 获取结果

### 2.4 任务执行双模式

`request_help(target_workspace_id, question, mode?, session_id?)`

| mode | 行为 | 实现方式 |
|------|------|---------|
| `foreground`（前台） | 注入目标 agent **当前 TUI 会话**，用户实时看到执行过程 | `tui.showToast()` 通知 → `tui.appendPrompt()` 注入任务 → `tui.submitPrompt()` **自动执行** |
| `background`（后台，**默认**） | 新会话后台执行，不打扰对方 | `session.create()` + `promptAsync()`；指定 `session_id` 时复用已有会话 |

**结果回传双保险**：
1. 首选：注入的 prompt 指示目标 agent 完成后主动调用 `submit_help_result` MCP 工具
2. 兜底：plugin 监听 session idle 事件，若结果未提交，自动抓取最后一条 assistant 消息提交

---

## 3. 数据模型

### users
| 字段 | 类型 | 说明 |
|------|------|------|
| id | str PK | shortuuid |
| username | str unique | 登录名 |
| password_hash | str | bcrypt |
| api_key_hash | str unique | sha256(apikey) |
| created_at | datetime | |

> apikey 明文仅在注册/重置时返回一次给用户。

### teams
| 字段 | 类型 | 说明 |
|------|------|------|
| id | str PK | shortuuid |
| name | str unique | |
| owner_id | str FK→users | 创建者 |
| created_at | datetime | |

### team_members
| 字段 | 类型 |
|------|------|
| team_id | FK→teams |
| user_id | FK→users |

### workspaces
| 字段 | 类型 | 说明 |
|------|------|------|
| id | str PK | shortuuid |
| user_id | FK→users | 归属用户（apikey 所有者） |
| team_id | FK→teams, nullable | 注册时可声明归属团队 |
| name | str | 工作区名称（默认取目录名） |
| path | str | 工作目录绝对路径 |
| purpose | str | 目录用途（AI 总结生成） |
| capabilities | str nullable | 能干什么的描述 |
| notes | str nullable | `/swarm-note` 累积的用户备注 |
| status | str | online / offline / disabled |
| last_heartbeat | datetime nullable | 心跳时间 |
| session_id | str nullable | opencode 当前会话（前台任务注入用） |
| created_at / updated_at | datetime | |

> 唯一约束: (user_id, path) — 同一用户同一目录只有一个工作区记录，重复注册即更新。

### help_requests
| 字段 | 类型 | 说明 |
|------|------|------|
| id | str PK | shortuuid |
| requester_ws_id | FK→workspaces | 求助方 |
| target_ws_id | FK→workspaces | 被求助方 |
| question | text | 问题描述（可含上下文） |
| mode | str | foreground / background，默认 background |
| session_id | str nullable | 后台模式指定目标会话 |
| status | str | pending → accepted → done / failed |
| result | text nullable | 目标 agent 的回复 |
| error | text nullable | 失败原因 |
| created_at / accepted_at / done_at | datetime | |

---

## 4. MCP 工具集（`/mcp`，全部需 apikey）

| 工具 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `register_workspace` | path, purpose?, capabilities? | workspace_id, created, **need_summary**, purpose | 注册/更新工作区；purpose 留空不覆盖已有值；need_summary=true 表示尚无总结，客户端应调 LLM 生成后 update_info 回写 |
| `heartbeat` | workspace_id | ok | 刷新在线状态 + last_heartbeat；同时可上报当前 session_id |
| `update_notes` | workspace_id, notes | ok | `/swarm-note` 命令落库（追加） |
| `update_info` | workspace_id, purpose?, capabilities? | ok | `/swarm-desc` 更新用途/能力 |
| `list_workspaces` | include_offline?=false | 工作区列表 | 只返回自己 + 所在 team 的；默认只在线且启用 |
| `request_help` | target_workspace_id, question, mode?=background, session_id? | request_id, status | 目标必须在线且启用 |
| `get_help_result` | request_id | status, result? | 轮询结果；只能查自己发起的 |
| `poll_help_requests` | — | 待处理任务列表 | 领取自己 workspace 的 pending 任务（标记 accepted） |
| `submit_help_result` | request_id, ok, result? | ok | 目标端提交结果（只能提交指向自己 workspace 的） |

### 在线判定
- `status == 'online'` 且 `last_heartbeat` 距今 < 心跳间隔 × 3（默认心跳 30s → 判定阈值 90s）
- `list_workspaces` 返回时动态计算：超时 → offline
- 用户 Web 端手动 disable → status='disabled'，agent 所有工具均不可见/不可达

---

## 5. 管理 REST API（`/api`，JWT 鉴权，auth 除外）

### auth
- `POST /api/auth/register` {username, password} → 201 {user, **api_key 明文一次性**}
- `POST /api/auth/login` {username, password} → {token, user}

### me
- `GET /api/me` → 当前用户信息
- `GET /api/me/apikey` → apikey 掩码显示
- `POST /api/me/apikey/reset` → 重置，返回新 apikey 明文（旧 key 立即失效）

### teams
- `POST /api/teams` {name} → 创建团队（owner=自己）
- `GET /api/teams` → 我的团队列表
- `POST /api/teams/{id}/members` {username} → owner 添加成员
- `GET /api/teams/{id}/members` → 成员列表
- `DELETE /api/teams/{id}/members/{user_id}` → owner 移除成员

### workspaces（管理视角）
- `GET /api/workspaces` → 我创建的 + 我所在 team 的全部工作区（含离线，含状态）
- `POST /api/workspaces/{id}/disable` → 禁用（不在线也可禁）
- `POST /api/workspaces/{id}/enable` → 启用
- `DELETE /api/workspaces/{id}` → **仅离线可删**（在线返回 409）

### help_requests（查看历史）
- `GET /api/help-requests?workspace_id=` → 求助记录列表

---

## 6. opencode 插件需求（TypeScript / tsx）

### 6.1 配置

`~/.config/opencode/agent-swarm.json`（或插件 options）：

```jsonc
{
  "serverUrl": "http://127.0.0.1:8700",
  "apiKey": "as_xxx",              // 必填
  "teamName": "my-team",           // 可选，注册时声明归属
  "enabled": true
}
```

### 6.2 启动注册

1. 读配置 → 校验 apikey（调 register 前先 heartbeat 或专用 verify）
2. 计算 `path = process.cwd()`（opencode 工作目录）
3. **AI 总结目录用途（按需）**：仅当 register 返回 `need_summary=true`（首次注册或尚无总结）才调 LLM（opencode 已配置模型，通过 /session 接口）分析目录结构生成 purpose 与 capabilities，再用 update_info 回写；LLM 失败时回退启发式摘要。已有总结则直接复用，不重复消耗 LLM
4. `register_workspace` 注册，拿到 workspace_id
5. 启动心跳定时器（30s），携带当前 session_id

### 6.3 自定义命令

| 命令 | 行为 |
|------|------|
| `/swarm-note <内容>` | 向工作区 notes 追加备注（调 `update_notes`） |
| `/swarm-desc <用途描述>` | 更新 purpose/capabilities（调 `update_info`） |
| `/swarm-resummarize` | 手动触发 LLM 重新总结目录用途并回写 |

### 6.4 工具注入（给当前 agent 用）

注册 MCP 工具让 agent 可自主调用：
- `swarm_list_workspaces` — 看有哪些同伴（在线的）
- `swarm_request_help` — 向指定工作区求助（含 mode/session_id 参数）
- `swarm_get_help_result` — 轮询结果

### 6.5 领任务与执行（plugin 后台轮询，如 10s 一次）

收到 pending 任务后按 mode 执行：

**foreground**：
1. `tui.showToast`："收到来自 {requester} 的求助"
2. `tui.appendPrompt` 注入格式化任务 prompt（含 question、要求完成后调用 submit 工具/命令）
3. `tui.submitPrompt` 自动提交执行

**background**：
1. 有 `session_id` → 直接对该会话 `promptAsync`
2. 无 → `session.create` 新会话 + `promptAsync`

### 6.6 结果回传双保险
1. 注入 prompt 中指示 agent 用 swarm 工具提交结果
2. plugin 订阅 session idle 事件，发现任务会话空闲且结果未提交 → 抓取最后 assistant 消息提交

---

## 7. Web 管理前端需求（React + Antd + Vite + TS）

### 页面
1. **登录/注册页**：注册成功弹窗展示一次性 apikey（强制复制提示）
2. **API Key 页**：掩码查看、一键复制（需先在服务端临时取回？——第一版：重置时展示一次）、重置（二次确认）
3. **团队页**：我的团队列表、创建团队、添加成员（按 username）、成员管理
4. **工作区看板**（核心）：
   - Tab 切换：我的 / 团队
   - 卡片或表格：名称、目录、用途（purpose）、能力、备注摘要、状态徽标（在线绿/离线灰/禁用红）、最后心跳时间
   - 操作：启用/禁用开关、删除（仅离线可用，Tooltip 说明）
   - 自动刷新（轮询 10s）
5. **求助记录页**：列表（时间、求助方→目标、问题摘要、状态、结果查看）

### 布局
Antd ProLayout 风格侧边栏 + 顶部用户区（username、退出）。

---

## 8. 非功能需求

- **安全**：所有 /mcp 强制 apikey；/api 强制 JWT（auth 除外）；apikey 哈希存储
- **可移植**：Python ≥3.11（3.11/3.12/3.13+ 均可），不固定小版本；依赖宽松约束；venv 各机器自建
- **部署**：单进程 uvicorn；SQLite 文件即数据库；第一版不做容器化
- **日志**：关键操作打日志（注册、求助、提交）
- **测试**：pytest 覆盖 API 与 MCP 工具核心链路

---

## 9. 里程碑

| # | 内容 | 状态 |
|---|------|------|
| M1 | 环境搭建 + 需求文档 | ✅ |
| M2 | 数据模型 + 管理 API | |
| M3 | MCP 端点 + 工具（apikey 校验） | |
| M4 | 帮助请求异步闭环 | |
| M5 | opencode 插件 | |
| M6 | Web 管理前端 | |
| M7 | 端到端联调 | |
