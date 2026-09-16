"""飞书卡片构造：宣传卡（未绑定引导）、工作区选择卡（select_static 下拉）。

卡片交互（select 提交 / 后续按钮）统一走 card action 回调（gateway.on_card_action），
value 里带 JSON：{"action": "...", ...}。Phase 1 只有两类卡；流式卡在 cards-v2。
"""
import json
from typing import Any


def promo_card() -> dict:
    """未绑定用户发消息时的宣传引导卡。"""
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "blue",
            "title": {"tag": "plain_text", "content": "🐝 agent_swarm · 多 agent 协作中枢"},
        },
        "elements": [
            {
                "tag": "div",
                "text": {
                    "tag": "lark_md",
                    "content": (
                        "把你的 **opencode / claude** 工作区注册到中枢，在飞书里直接派活：\n"
                        "- 📨 发消息给工作区里的 AI，实时看 thinking / 工具调用 / 回答\n"
                        "- 👀 开启监控后，TUI 里的对话实时同步到这里\n"
                        "- 🔐 权限申请远程一键允许/拒绝\n\n"
                        "**还没有绑定账号？**\n"
                        "1. 打开中枢网页注册/登录\n"
                        "2. 在「API Key」页复制密钥（as_ 开头）\n"
                        "3. 回到这里发送 `/swarm bind as_你的密钥`"
                    ),
                },
            },
            {"tag": "hr"},
            {
                "tag": "note",
                "elements": [
                    {"tag": "plain_text", "content": "发送 /swarm help 查看全部指令"}
                ],
            },
        ],
    }


def select_card(workspaces: list[dict], current_wid: str = "") -> dict:
    """工作区选择卡：下拉只列**在线**工作区，form 提交后回写窗口选中状态。

    结构对齐 opencode-feishu bridge 的成熟模式：select_static + form 容器 +
    提交按钮命名约定 btn_submit_<formName>（form_action_type=submit）。
    注意：button.value 在飞书协议里是 object，SDK 回调模型要求 Dict——
    不能 json.dumps 成字符串（曾致回调 unmarshal 报 "expected Dict but was str"）。
    """
    options = []
    for w in workspaces:
        if not w["online"]:
            continue
        label = f"{w['name']}（{w['agent_type'] or '未知'}）"
        options.append({
            "text": {"tag": "plain_text", "content": label},
            "value": w["id"],
        })
    if not options:
        return {
            "config": {"wide_screen_mode": True},
            "header": {
                "template": "orange",
                "title": {"tag": "plain_text", "content": "没有在线的工作区"},
            },
            "elements": [{
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": "先在目标机器上打开 opencode / claude（插件会自动心跳上线），再发 `/swarm select`。"},
            }],
        }
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "blue",
            "title": {"tag": "plain_text", "content": "选择工作区"},
        },
        "elements": [
            {
                "tag": "form",
                "name": "ws_select",
                "direction": "vertical",
                "elements": [
                    {
                        "tag": "select_static",
                        "name": "workspace_select",
                        "placeholder": {"tag": "plain_text", "content": "请选择在线工作区"},
                        "options": options,
                    },
                    {
                        "tag": "button",
                        "name": "btn_submit_ws_select",
                        "text": {"tag": "plain_text", "content": "确认选择"},
                        "type": "primary",
                        "form_action_type": "submit",
                    },
                ],
            },
        ],
    }


def text_payload(text: str) -> str:
    """im message.create 的 content 字段（text 类型）。"""
    return json.dumps({"text": text}, ensure_ascii=False)


def card_payload(card: dict) -> str:
    """im message.create 的 content 字段（interactive 卡片类型）。"""
    return json.dumps(card, ensure_ascii=False)
