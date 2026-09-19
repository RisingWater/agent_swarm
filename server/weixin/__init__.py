"""nexus-weixin-clawbot：微信 ClawBot 渠道接入中枢。

- 每用户扫自己的微信号登录为 bot（iLink 协议，官方开放接口），本人 ↔ 自有 ClawBot 会话私聊交互
- bot_token 按用户 apikey 加密落库（weixin_logins.token_enc）；getupdates 游标/最近 context_token 持久化
- 指令 /swarm select|list|status|last|monitor|brief；普通文本 = 待应答任务优先路由，否则按选中工作区下发
- 下发复用 nexus._send_message_core（caller="nexus-weixin-clawbot"），事件流自动落库 + 推 web
- WEIXIN_CLAWBOT 未开启时整个模块静默不启动
"""
