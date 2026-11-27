---
name: swarm-add
description: 将当前 Codex 项目注册到 Agent Swarm。
---

同一用户在同一目录已有其他客户端类型的工作区时，沿用原 ID。先确认原适配器已断开，再调用注册工具将类型更新为 Codex。

用当前目录的规范绝对路径注册，Windows 路径统一使用 `/`。先检查项目根 `.agent_swarm/workspace.md` 中已有的 `WORKSPACE_ID:`。如有该行，用 `list_workspaces(include_offline=true)` 核对原 ID，发现归属冲突时先说明。根据项目资料提炼 `purpose` 与 `capabilities`，调用 Swarm MCP 的 `workspace_add`，传 `agent_type="codex"` 并保留已有角色。成功后把返回的 `workspace_id` 保存到对应行，保留其他内容。报告工作区 ID。在该目录启动 Codex 后，MCP 自动启动 worker 接收任务。
