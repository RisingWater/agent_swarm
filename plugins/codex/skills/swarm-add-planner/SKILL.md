---
name: swarm-add-planner
description: 将当前 Codex 工作目录注册为 Agent Swarm 规划器工作区。
---

同一用户在同一目录已有其他客户端类型的工作区时，沿用原 ID。先确认原适配器已断开，再调用注册工具将类型更新为 Codex。

检查项目根 `.agent_swarm/workspace.md` 中已有的 `WORKSPACE_ID:`，如有该行，用 `list_workspaces(include_offline=true)` 核对归属，发现冲突时先说明。通过 `workspace_add` 注册当前目录的规范绝对路径，Windows 路径统一使用 `/`。传 `agent_type="codex"` 和 `role="planner"`。成功后把返回的 ID 保存到对应行，保留其他内容。报告工作区 ID 与角色。规划器的状态与控制通道由独立规划核心服务提供。
