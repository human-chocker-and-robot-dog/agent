# DIMOS 机器狗 MCP 调研记录

日期：2026-07-23

## 结论

用户指出的 [dimensionalOS/dimos](https://github.com/dimensionalOS/dimos) 才是本项目应对接的 DIMOS。它已经内置 MCP Server、技能发现和 Unitree Go2 连接能力；本 MVP 应作为 DIMOS 扩展发布 `@skill`，而不是实现一个脱离 DIMOS 的 MCP 服务或直接拼接 ROS 2 CLI。

## 一手证据

- [项目 README](https://github.com/dimensionalOS/dimos/blob/main/README.md) 将 DIMOS 定位为物理空间的 Agent 操作系统，并给出 `dimos run unitree-go2-agentic`、`dimos mcp list-tools` 和 `dimos mcp call` 的使用方式。
- [MCP README](https://github.com/dimensionalOS/dimos/blob/main/dimos/agents/mcp/README.md) 明确说明：`McpServer` 在蓝图中启动 FastAPI，客户端以 Streamable HTTP 连接 `http://localhost:9990/mcp`。
- [McpServer 实现](https://github.com/dimensionalOS/dimos/blob/main/dimos/agents/mcp/mcp_server.py) 把所有 DIMOS 模块的 `@skill` 方法转换为 `tools/list` 和 `tools/call` 的 MCP 工具；服务端实现的是 HTTP `/mcp`，不是 stdio 子进程协议。
- [`@skill` 实现](https://github.com/dimensionalOS/dimos/blob/main/dimos/agents/annotation.py) 支持 `uses` capability。`movement` capability 用于排斥并发运动工具。
- [Go2 连接模块](https://github.com/dimensionalOS/dimos/blob/main/dimos/robot/unitree/go2/connection.py) 定义 `cmd_vel: In[Twist]`，并将输入转发给机器狗连接；该模块也是官方机器人蓝图使用的稳定接入点。
- [Go2 原生适配器](https://github.com/dimensionalOS/dimos/blob/main/dimos/hardware/drive_trains/unitree_go2/adapter.py) 的高层接口以 `write_velocities([vx, vy, wz])` 执行速度命令、以 `write_stop()` 执行立即停止。
- [速度任务](https://github.com/dimensionalOS/dimos/blob/main/dimos/control/tasks/velocity_task/velocity_task.py) 的默认超时为 0.2 秒并可在超时发送零速度，印证了“速度命令必须有死手/零速度边界”的设计方向。

## MVP 设计

新增 `integrations/dimos-dog-mcp`，而不修改 DIMOS 或 Pi 核心：

1. `DogMotionSkill` 使用 `@skill` 暴露 `move_forward`、`move_backward`、`stop_motion`、`motion_status`。
2. 技能将速度转成标准 DIMOS `Twist`，并发布到 `cmd_vel`。
3. 默认 `dry-run` 接入内部 sink，不连接任何真实硬件；基础依赖仅安装 DIMOS `base` extra，显式 `DIMOS_DOG_MCP_MODE=go2` 和 `go2` 可选依赖才会惰性导入官方 `GO2Connection`。
4. 运动命令限制为 `0.01–0.20 m/s` 和 `0.1–2.0 s`，运行期间按 10 Hz 发布，正常结束、显式停止和模块关闭均发送零速度。
5. 前进与后退立即启动后台短时运动；本地状态机拒绝重叠动作，停止工具可抢占当前动作，因此不依赖 DIMOS RPC 是否并行调度。

## 已知边界

- 当前实机实现只装配 DIMOS 官方文档中的 Unitree Go2 连接。其他机器狗必须提供一个消费 `cmd_vel: Twist` 的 DIMOS 模块后再接入。
- `motion_status` 仅是 MCP 扩展的本地命令状态，不能替代机器狗遥测、急停或碰撞检测。
- DIMOS 当前 MCP 服务对客户端断连不等同于运动取消；MVP 用 2 秒最大持续时间限制风险，实机操作必须保留独立急停并在需要时调用 `stop_motion`。
