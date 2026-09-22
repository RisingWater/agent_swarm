"""飞书产物推送：agent 上传文件后，按简报规则推送到属主 brief_on 的窗口。

先传飞书文件（im.v1.file.create，executor 同步 SDK），成功后发 file 消息；
失败降级为文本（文件名 + 签名下载链接）。
"""
import asyncio
import json
import logging
from pathlib import Path

from lark_oapi.api.im.v1 import CreateFileRequest, CreateFileRequestBody, CreateMessageRequest, CreateMessageRequestBody

from server import artifacts, models
from server.feishu import state

log = logging.getLogger("nexus-feishu")


def _gw_ref():
    """复用 brief 的网关引用（gateway.start 时已 set_gateway）。"""
    from server.feishu import brief

    return brief._gw_ref()


async def push_artifact(row: models.Artifact, base: str = "") -> None:
    gw = _gw_ref()
    if gw is None:
        return
    chats = state.brief_chats_all(row.user_id, set())
    if not chats:
        return
    path = artifacts.file_path(row.id, row.name)
    if not path.exists():
        log.warning("产物文件缺失，跳过推送 id=%s", row.id)
        return
    text_fallback = (
        f"📦 新产物：**{row.name}**（{_human_size(row.size)}）\n"
        f"下载（30 天内有效）：{artifacts.download_url(row, base)}"
    )
    for chat in chats:
        try:
            ok = await _send_file(gw, chat.chat_id, path, row.name)
            if ok:
                await gw.send_text(chat.chat_id, f"📦 产物 {row.name}（{_human_size(row.size)}）已上传，见上方文件；也可在 web「产物」页管理。")
            else:
                await gw.send_text(chat.chat_id, text_fallback)
        except Exception:  # noqa: BLE001
            log.exception("产物推送失败 chat=%s artifact=%s", chat.chat_id, row.id)


def _human_size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / 1048576:.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


async def _send_file(gw, chat_id: str, path: Path, name: str) -> bool:
    """上传文件到飞书并发 file 消息。返回是否成功（False = 用方降级发链接）。"""
    loop = asyncio.get_running_loop()

    def _upload() -> str | None:
        with path.open("rb") as f:
            req = CreateFileRequest.builder().request_body(
                CreateFileRequestBody.builder()
                .file_type("stream")
                .file_name(name)
                .file(f)
                .build()
            ).build()
            resp = gw.lark.im.v1.file.create(req)
        if resp.success() and resp.data and resp.data.file_id:
            return resp.data.file_id
        log.error("飞书文件上传失败 %s: %s", name, resp.msg)
        return None

    file_id = await loop.run_in_executor(None, _upload)
    if not file_id:
        return False
    content = json.dumps({"file_key": file_id})
    req = CreateMessageRequest.builder() \
        .receive_id_type("chat_id") \
        .request_body(CreateMessageRequestBody.builder()
                      .receive_id(chat_id)
                      .msg_type("file")
                      .content(content)
                      .build()) \
        .build()
    resp = await loop.run_in_executor(None, gw.lark.im.v1.message.create, req)
    if not resp.success():
        log.error("飞书文件消息发送失败 chat=%s: %s", chat_id, resp.msg)
        return False
    return True
