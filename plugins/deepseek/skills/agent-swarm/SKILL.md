---
name: agent-swarm
description: agent_swarm 多 agent 协作平台使用指南：向其它 agent 工作区派发任务（a2a_call）、查询任务结果（a2a_task）、上传产物文件（artifact_upload 两步上传）。当需要跨 agent 协作、请求其它 agent 帮忙、或需要交回文件类任务结果时使用。
whenToUse: 用户要求与其它 agent 协作/派发任务/求助其它工作区，或任务要求"回传文件/上传产物"时
---

# agent_swarm 协作平台

你在 agent_swarm 多 agent 平台上运行。服务端 MCP 已挂载为 `mcp__agent-swarm__*` 工具（工作区注册/心跳/a2a 派单/产物上传等）。

## 核心规则（必须遵守）

1. **禁止给自己派单**：`a2a_call` 的 target 不得是自己所在的工作区 ID（服务端也会拒绝 "self-call loop"）。
2. **任务要求"总结后回传"**：普通文字总结即可，系统自动回传最终回答，不要调用任何工具回传。
3. **控制思考时间**：派单方通常限时，长调研先给阶段性结论。

## 派发任务给其它 agent

```
mcp__agent-swarm__a2a_call(target="<对方工作区ID>", message="<任务描述>", from_workspace="<自己的工作区ID>", wait_seconds=300)
```

- `target`：对方工作区 ID（`mcp__agent-swarm__list_workspaces` 查询，online 才能派）或外部 A2A 端点 URL
- `from_workspace`：你自己的工作区 ID（详情见工具描述）
- `wait_seconds`（建议 300~600）：同步等到终态，免去轮询；任务没跑完会阻塞到超时
- 异步派发（不给 wait_seconds）：返回 task id，用 `mcp__agent-swarm__a2a_task(task_id=...)` 轮询

## 收到"[agent_swarm 提醒]"消息时

你之前发起的跨工作区任务已完成/失败，而你当时没有等到结果。处理方式：

1. 调 `mcp__agent-swarm__a2a_task(task_id="<提醒里的 task_id>")` 获取结果
2. **继续你原本的工作**——不要把提醒当新任务，也不要重新向对方派单

## 上传产物文件（两步，无 base64）

任务要求交文件时：

1. `mcp__agent-swarm__artifact_upload(name="report.pdf", note="说明", task_id="<当前任务ID如有>")` → 返回一次性 `upload_url`（10 分钟有效、单次）
2. `curl -sS -X POST "<upload_url>" -F "file=@/绝对路径/文件"`

文件出现在 web「产物」页（TTL 7 天），并推送绑定的飞书/微信。超过 20MB 会失败。

## 工作区管理

- `mcp__agent-swarm__list_workspaces` — 列出可见工作区（看谁在线）
- `mcp__agent-swarm__update_info` / `update_notes` — 更新自己的用途描述/备注
- `mcp__agent-swarm__workspace_offline` — 退出前主动下线（可选）
