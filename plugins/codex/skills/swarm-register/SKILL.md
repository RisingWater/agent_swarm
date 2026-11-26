---
name: swarm-register
description: 分析当前 Codex 项目的用途和能力，再把它注册到 Agent Swarm。
---

根据项目资料提炼用途和能力。检查项目根 `.agent_swarm/workspace.md` 中已有的 `WORKSPACE_ID:`，如有该行，用 `list_workspaces(include_offline=true)` 核对归属，发现冲突时先说明。通过 `workspace_add` 注册当前目录的规范绝对路径，Windows 路径统一使用 `/`。传 `agent_type="codex"` 并保留已有角色。成功后把返回的 ID 保存到对应行，保留其他内容。报告注册结果。
