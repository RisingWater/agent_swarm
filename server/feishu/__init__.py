"""nexus-feishu：飞书渠道接入中枢。

- 飞书 WS 长连接（lark-oapi，独立线程）→ asyncio 桥到主事件循环
- 用户绑定 apikey（feishu_bindings）；聊天窗口选中工作区（feishu_chats）
- 指令 /swarm help|bind|unbind|list|select|status|monitor|last；普通文本 = 下发任务
- 下发复用 nexus._send_message_core（caller="nexus-feishu"），事件流自动落库 + 推 web
- FEISHU_APP_ID/FEISHU_APP_SECRET 未配置时整个模块静默不启动
"""
