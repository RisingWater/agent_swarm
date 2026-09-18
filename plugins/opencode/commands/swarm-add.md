---
description: 添加（或更新）当前工作区到 agent_swarm
---
调用 workspace_add 工具（path=当前目录绝对路径；$ARGUMENTS 非空时作为 purpose）。通过 MCP 工具完成（mcp 服务器名 agent-swarm，工具名加 agent-swarm__ 前缀）。
若返回 need_summary=true：分析当前项目（读 README/AGENTS.md/package.json 等），生成 PURPOSE（项目是什么、用于什么场景）与 CAPABILITIES（技术栈/能完成的任务类型）两行概括（各≤80字），调用 update_info 工具回写（purpose/capabilities 两个参数）。
然后把返回的 workspace_id 写入当前目录 `.agent_swarm/workspace.md` 的 `WORKSPACE_ID:` 行（文件已存在则更新该行，不存在则新建目录 `.agent_swarm/` 与文件并加 PURPOSE:/CAPABILITIES: 占位行）。若文件里 PURPOSE:/CAPABILITIES: 为空，把上面生成的两行也写入文件。
工具执行结果原样汇报给用户。
