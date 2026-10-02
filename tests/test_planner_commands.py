# -*- coding: utf-8 -*-
"""规划器注册命令 `/swarm-add-planner` 的三 harness 一致性测试（2026-10-02）。

命令是 md/源码文本，跑不了运行时；这里做静态校验，防止回归：
  - opencode / claude 有独立命令文件，且显式传 role="planner"、写 WORKSPACE_ID
  - /swarm-add 三个 harness 都没有 planner 参数（用户明确要求保持原样）
  - opencode 安装脚本（显式清单）分发新命令；claude 安装脚本用 glob 自动分发
  - deepseek 在 commands.ts 里注册（源码内注册）+ register.mjs 支持 --role
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


# ---------------------------------------------------------------- 命令文件

def test_opencode_planner_command_file():
    t = _read("plugins/opencode/commands/swarm-add-planner.md")
    assert 'role="planner"' in t
    assert "agent-swarm__workspace_add" in t
    assert "WORKSPACE_ID" in t
    assert "update_info" in t  # need_summary 回填


def test_claude_planner_command_file():
    t = _read("plugins/claude/commands/swarm-add-planner.md")
    assert 'role="planner"' in t
    assert "mcp__agent-swarm__workspace_add" in t
    assert "mcp__agent-swarm__update_info" in t
    assert "WORKSPACE_ID" in t


def test_swarm_add_stays_argument_free():
    """/swarm-add 的 md 命令保持原样，不引入 planner/--planner 参数。"""
    for rel in (
        "plugins/opencode/commands/swarm-add.md",
        "plugins/claude/commands/swarm-add.md",
    ):
        t = _read(rel).lower()
        assert "planner" not in t, f"{rel} 不应提到 planner"
        assert "--planner" not in t, f"{rel} 不应有 --planner"


# ---------------------------------------------------------------- 安装分发

def test_opencode_installer_distributes_planner_command():
    for rel in ("plugins/opencode/install-opencode.sh", "plugins/opencode/install-opencode.ps1"):
        t = _read(rel)
        assert "swarm-add-planner" in t, f"{rel} 未分发 /swarm-add-planner"


def test_claude_installer_globs_swarm_commands():
    for rel in ("plugins/claude/install-claude.sh", "plugins/claude/install-claude.ps1"):
        t = _read(rel)
        assert "swarm-*.md" in t, f"{rel} 应 glob swarm-*.md 以自动分发新命令"


# ---------------------------------------------------------------- deepseek 原生注册

def test_deepseek_registers_planner_command():
    t = _read("plugins/deepseek/src/commands.ts")
    assert 'register("swarm-add-planner"' in t
    assert 'register("swarm-add"' in t
    # 两个命令共享同一注册逻辑，只有 role 不同
    assert 'registerWorkspace("planner")' in t
    assert 'registerWorkspace("")' in t
    # bundle/distribution 包含源码（package.json files: src/*）
    assert "src/*" in _read("plugins/deepseek/package.json")


def test_deepseek_register_mjs_supports_role():
    t = _read("plugins/deepseek/register.mjs")
    assert 'arg("role")' in t
    assert "...(role ? { role } : {})" in t
