# 以持久化 Webhook 处理 Agent 输入与最终回复

状态：已接受。

外部应用不得通过 MCP 或 DIMOS 直接向 Agent 注入用户文本。MVP 选择独立的 HTTP 输入网关与输出投递器：输入事件以稳定 `instruction_id` 持久化后返回 `202 Accepted`，固定 Agent 会话完成处理后将终态回复以稳定 `reply_id` 写入 outbox 并回调下层。相较于同步请求或直接 MCP 调用，这一边界保留了输入去重、输入与回复关联以及回调重试不会重跑 Agent 或机器狗工具的保证。规范化后精确匹配“停”或“stop”的语音停止口令是唯一例外：它从输入网关绕过 Agent 会话，单次转发统一的 `stop_all`，但不能取代物理急停。
