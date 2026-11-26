---
name: swarm-notes
description: 更新当前项目的 Agent Swarm 工作区备注。
---

通过 Swarm MCP 调用 `list_workspaces(include_offline=true)`，用当前目录的规范绝对路径查找自有的 Codex 工作区，Windows 路径统一使用 `/`，核对 `.agent_swarm/workspace.md` 中已有的 ID。无法唯一确定工作区时先说明原因。调用 `update_notes` 并报告结果。使用用户提供的备注内容。默认追加，用户明确要求覆盖时传 `append=false`。
