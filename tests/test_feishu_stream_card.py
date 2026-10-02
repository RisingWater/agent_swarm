# -*- coding: utf-8 -*-
"""飞书时间线：思考过程拼接 + 关闭打字机（streaming_config）回归（2026-10-03）。

用户反馈：飞书 thinking 只一段一段显示、结束时才一口气出现全文；且打字机太慢。
根因：reasoning 事件带 mode=append（delta）/replace（全量），但 Feishu 侧忽略 mode，
同一 part 每次都 replace_text(片段)；且卡片用飞书默认打字机（70ms/1 字）。
"""
import pytest

from server.feishu import stream_card


class _DummyGW:
    lark = None


class _FakeCard:
    def __init__(self):
        self.texts: list[str] = []

    def replace_text(self, text: str) -> None:
        self.texts.append(text)


@pytest.mark.asyncio
async def test_schema_turns_off_typewriter():
    card = stream_card.TimelineCard(_DummyGW(), "chat")
    cfg = card._schema("标题")["config"]
    assert cfg["streaming_mode"] is True  # 流式更新接口要求，不能关
    sc = cfg["streaming_config"]
    assert sc["print_step"]["default"] >= 2800  # 一次渲染全部（卡片文本上限 2800）
    assert sc["print_frequency_ms"]["default"] <= 20
    assert sc["print_strategy"] == "fast"


@pytest.mark.asyncio
async def test_thinking_concatenates_across_parts_and_replace():
    rc = stream_card.RoundCards(_DummyGW(), "chat", "rk")
    try:
        rc.ensure_thinking("p1", "abc", "append")
        rc.ensure_thinking("p1", "def", "append")  # 同 part 增量 → 拼接
        assert rc._pending["think"]["content"] == "abcdef"
        rc.ensure_thinking("p2", "xyz", "append")  # 新 part → 追加，仍是一张卡
        assert rc._pending["think"]["content"] == "abcdef\n\nxyz"
        rc.ensure_thinking("p1", "abcdefg", "replace")  # 全量快照覆盖该 part
        assert rc._pending["think"]["content"] == "abcdefg\n\nxyz"
        assert "think" in rc._pending and "think:p1" not in rc._pending
    finally:
        if rc._flush_task:
            rc._flush_task.cancel()
        await rc.aclose()


@pytest.mark.asyncio
async def test_thinking_monitor_heuristic_without_mode():
    """监控轮旧插件不带 mode：非前缀→增量拼接；以旧为前缀→全量快照。"""
    rc = stream_card.RoundCards(_DummyGW(), "chat", "rk")
    try:
        rc.ensure_thinking("m", "hello ", "")
        assert rc._pending["think"]["content"] == "hello "
        rc.ensure_thinking("m", "world", "")
        assert rc._pending["think"]["content"] == "hello world"
        rc.ensure_thinking("m", "hello world!", "")
        assert rc._pending["think"]["content"] == "hello world!"
    finally:
        if rc._flush_task:
            rc._flush_task.cancel()
        await rc.aclose()


@pytest.mark.asyncio
async def test_thinking_updates_existing_card():
    rc = stream_card.RoundCards(_DummyGW(), "chat", "rk")
    try:
        fake = _FakeCard()
        rc.thinking_card = fake
        rc.ensure_thinking("p1", "aa", "append")
        rc.ensure_thinking("p1", "bb", "append")
        assert fake.texts[-1] == "aabb"  # 累积后整段推给同一张卡
    finally:
        if rc._flush_task:
            rc._flush_task.cancel()
        await rc.aclose()
