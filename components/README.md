# 机器人 Agent 组件

`components/` 是本组合仓库中自研机器人能力的唯一组件根目录。

| 组件 | 部署位置 | 职责 |
| --- | --- | --- |
| [`dimos-mcp`](dimos-mcp/README.md) | 机器狗侧主机 | 将 HTTP MCP 工具调用转换为 DIMOS 运动指令。 |
| [`agent-framework`](agent-framework/README.md) | 上层 Agent 主机 | 接收用户指令、运行 Agent、包装并转发 MCP 调用、投递最终回复。 |

两个组件可以独立安装、测试和部署。`agent-framework` 只通过 HTTP MCP 调用 `dimos-mcp`，不得导入后者的 Python 内部模块。

```text
Agent Framework -> HTTP MCP -> DIMOS MCP -> Machine Dog
```
