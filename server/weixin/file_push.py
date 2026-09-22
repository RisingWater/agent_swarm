"""微信产物推送：agent 上传文件后，推给已登录且 brief_on 的属主（其本人微信）。

iLink 2.4.6 sendmessage 的文件 item 官方文档未在本地（协议参考在用户 Windows 机器），
先按 item_list 结构试常见文件形态；失败回退文本下载链接（签名 URL，30 天有效）。
"""
import logging
import mimetypes
from pathlib import Path

import httpx

from server import artifacts, models
from server.db import engine
from server.weixin import gateway, state as wx_state
from sqlmodel import Session

log = logging.getLogger("nexus-weixin")


async def push_artifact(row: models.Artifact, base: str = "") -> None:
    with Session(engine) as s:
        login = s.get(models.WeixinLogin, row.user_id)
    if login is None or not login.brief_on:
        return
    sess = gateway.peek_session(row.user_id)
    if sess is None or not sess.token:
        return
    path = artifacts.file_path(row.id, row.name)
    if not path.exists():
        log.warning("产物文件缺失，跳过微信推送 id=%s", row.id)
        return
    link_text = (
        f"📦 新产物：{row.name}（{_human_size(row.size)}）\n"
        f"下载（30 天内有效）：{artifacts.download_url(row, base)}"
    )
    sent = await _try_send_file(sess, path, row.name)
    if not sent:
        await _send_link(sess, link_text)
    else:
        await _send_link(sess, f"📦 产物 {row.name}（{_human_size(row.size)}）已上传，见上方文件；也可在 web「产物」页管理。")


def _human_size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1048576:.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


async def _send_link(sess: gateway.UserSession, text: str) -> None:
    from server.weixin.bridge import _send

    await _send(sess, text)


async def _try_send_file(sess: gateway.UserSession, path: Path, name: str) -> bool:
    """尝试 iLink 文件 item。任何失败都返回 False（调用方降级为链接）。"""
    if not sess.context_token:
        return False
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    candidates = [
        # 形态 A：type 2 file_item（猜）
        {"type": 2, "file_item": {"file_name": name, "media_type": mime, "file_path": str(path)}},
    ]
    client = sess.client or httpx.AsyncClient()
    for items in candidates:
        try:
            await gateway.send_tool_items(client, sess.token, sess.baseurl, sess.wx_user_id, sess.context_token, items)
            log.info("weixin file item sent user=%s file=%s", sess.user_id[:8], name)
            return True
        except gateway.ILinkError as exc:
            log.info("weixin file item rejected (ret=%s errcode=%s), falling back to link", exc.ret, exc.errcode)
            return False
        except Exception:  # noqa: BLE001
            log.exception("weixin file item crash")
            return False
    return False
