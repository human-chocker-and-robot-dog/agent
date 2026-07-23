# DIMOS 机器狗 MCP 框架使用与开发指南

本文件面向框架使用者和集成开发者，说明如何把上层 Agent/MCP Host 接入本框架、如何把本框架接入下层机器狗，以及如何在既有边界内扩展。

开始使用前，先阅读根目录的 [CONTEXT.md](CONTEXT.md)。它定义了安全边界和不可违反的架构约束；本文件定义安装、接入和开发流程。

输入端系统向 Agent 输入用户文本、并由回复接收端接收最终回复时，遵循 [Agent 输入与最终回复 Webhook 对接指南](docs/agent-input-webhook-integration.md)。输入端负责确认每个 Webhook 都是完整真实请求；本框架不处理麦克风或语音识别。`components/agent-framework/agent-webhook-gateway` 已实现持久化输入网关、固定 Pi Agent 会话和输出投递器：Agent 无法完成时返回固定的用户可见文本，便于回复接收端直接显示或 TTS 朗读；系统提示词要求模型对参数不明确的运动请求追问，并支持“速度加时长”“距离加时长”或仅说距离，方向可选且默认向前，其中距离仅按部署标定速度进行估算。Agent 还可调用 DIMOS 官方的具名地点导航、Frontier 探索和已知地图巡逻工具。该自然语言语义目前没有程序级策略门，不能当作确定性安全保证。规范化后精确等于“停”或 `stop` 的语音停止口令会由代码绕过 Agent 并直接触发 `stop_motion`，被 MCP 接受后返回“已发送停止指令。”，但不替代物理急停，也不取消官方导航、探索或巡逻后台任务。不要把 MCP 端点当作文本输入端点。

## 架构与职责

~~~mermaid
flowchart LR
    I["输入端"] -->|HTTP Webhook :8080| A["固定 Pi Agent"]
    A -->|HTTP MCP :9991/mcp| W["dimos-mcp-wrapper"]
    W -->|"受信任网络上的一次 tools/call"| D["独立 dimos-mcp :9990/mcp"]
    D -->|DIMOS cmd_vel: Twist| C{"下层连接"}
    C -->|默认| R["dry-run"]
    C -->|显式启用| G["Unitree Go2"]
    W -. 生命周期事件 .-> K["可选 hook"]
    A -->|最终回复 Webhook| O["回复接收端"]
~~~

| 层级 | 组件 | 使用者应负责的事项 |
| --- | --- | --- |
| 上层 | MCP Host / Agent | 需要 hook 或 Agent Gateway 时连接包装器；独立 MCP Host 也可直接连接底层。 |
| Agent Webhook 层 | `components/agent-framework/agent-webhook-gateway` | 持久化用户文本、串行运行固定 Agent 会话并投递最终回复。 |
| 转发层 | `components/agent-framework/dimos-mcp-wrapper` | 原样、单次转发工具调用；可发出非阻塞 hook 事件。 |
| 下层 | `components/dimos-mcp` | 部署在机器狗侧主机，执行定时速度动作；Go2 模式组合官方地图、A*、探索和巡逻模块。 |
| 硬件层 | DIMOS 连接与导航模块 | dry-run 只模拟定时运动；显式 Go2 模式消费传感器与 `cmd_vel` 并执行官方导航。 |

Agent Webhook Gateway 不应直接连接底层机器狗 MCP，否则会绕过包装器的统一转发点和 hook 扩展点。明确不需要 hook 的独立 MCP Host 可以直接连接 `components/dimos-mcp` 暴露的网络 endpoint。

## 前置条件与安全要求

- 使用 Python 3.10 至 3.12；推荐 Python 3.12。DIMOS 0.0.14b1 不支持 Python 3.13 及以上。
- 默认 MCP 安装精确版本的 `dimos[web]` 和 `langchain-core`。`web` extra 提供 FastAPI/Uvicorn；`langchain-core` 是 DIMOS 0.0.14b1 生成 `@skill` 参数 schema 时实际导入的运行依赖。该组合不会额外启用完整的 `dimos[base]` 聚合 extra。
- 真实 Go2 仍使用显式的 `dimos[unitree]` 可选依赖。DIMOS 上游将它建立在更大的 base 依赖集合上，因此只在实机部署确有需要时安装。
- 默认运行模式是 dry-run：不会连接、站立或移动真实机器狗。
- 启用真实 Go2 前，必须完成场地隔离、独立急停、低延迟网络和厂商/DIMOS 网络预检。
- 当前 MCP 服务没有内建访问控制。不要把 `:9990/mcp` 或 `:9991/mcp` 暴露到不受信任网络；跨主机部署时应由可信网络和外部访问控制保护。

## 接入下层机器狗

### 1. 在底层机器安装独立 MCP

以下示例假设仓库绝对路径保存在 `REPOSITORY_PATH`。

PowerShell：

~~~powershell
$repositoryPath = "C:/absolute/path/to/pi-hackason"
uv venv --python 3.12
.\.venv\Scripts\Activate.ps1
uv pip install -e "$repositoryPath/components/dimos-mcp"
~~~

POSIX shell：

~~~bash
repository_path="/absolute/path/to/pi-hackason"
uv venv --python 3.12
source .venv/bin/activate
uv pip install -e "$repository_path/components/dimos-mcp"
~~~

### 2. 启动下层机器狗 MCP

先启动下层服务。未设置模式时，它以 dry-run 运行并监听默认地址 `http://127.0.0.1:9990/mcp`。

~~~bash
dimos-dog-mcp
~~~

要让另一台上层机器访问，底层机器必须显式监听网络 interface：

~~~powershell
$env:DIMOS_DOG_MCP_HOST = "0.0.0.0"
$env:DIMOS_DOG_MCP_PORT = "9990"
dimos-dog-mcp
~~~

假设底层机器 IP 为 `192.168.66.160`，上层调用 URL 是 `http://192.168.66.160:9990/mcp`。`0.0.0.0` 只用于监听，不能作为客户端 URL。底层主机防火墙应只允许上层机器或受信任网段访问 TCP 9990。

下层公开 11 个工具。4 个定时运动工具在 dry-run 和 Go2 模式均可调用：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `move_forward` | `speed_mps`、`duration_s` | 按给定时长前进，结束时发布零速度。 |
| `move_backward` | `speed_mps`、`duration_s` | 按给定时长后退，结束时发布零速度。 |
| `stop_motion` | 无 | 取消当前本地运动并立即发布零速度。 |
| `motion_status` | 无 | 返回本地命令执行状态，不是机器狗遥测。 |

运动速度和持续时间接受用户提供的任意正有限数值，不设置硬编码范围上限或下限。默认值分别为 0.10 m/s 和 1.0 秒；重叠的运动请求仍会被拒绝。

7 个官方导航工具只在 Go2 模式执行：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `tag_location` | `location_name` | 将当前地图位置保存为具名地点。 |
| `navigate_with_text` | `query` | 解析自然语言目的地，并通过 DIMOS `ReplanningAStarPlanner` 导航。 |
| `stop_navigation` | 无 | 取消当前定点导航目标。 |
| `begin_exploration` | 无 | 启动 DIMOS Wavefront Frontier 未知区域探索。 |
| `end_exploration` | 无 | 停止当前探索。 |
| `start_patrol` | 无 | 在已知地图内启动自主巡逻。 |
| `stop_patrol` | 无 | 停止当前巡逻。 |

dry-run 的 `tools/list` 仍返回这 7 个工具，以保持上下层契约稳定；调用时返回 `{"status":"error",...,"required_mode":"go2"}`，不会伪造地图、位置、路径或动作。

### 3. 启用真实 Unitree Go2（可选）

只有在完成安全检查后，才在启动下层服务前显式设置 Go2 模式：

~~~powershell
$env:ROBOT_IP = "机器狗 IP"
$env:DIMOS_DOG_MCP_MODE = "go2"
uv pip install -e "$repositoryPath/components/dimos-mcp[go2]"
dimos-dog-mcp
~~~

Go2 模式组合 DIMOS 官方 `unitree_go2_spatial` Blueprint 和 `NavigationSkillContainer`，其中包括 `GO2Connection`、体素地图、代价地图、`ReplanningAStarPlanner`、`WavefrontFrontierExplorer`、`PatrollingModule` 与 `MovementManager`。不要将任何其他设备伪装为 Go2。

若要接入非 Go2 设备，应在下层扩展中组合该设备对应的 DIMOS 连接模块，并让它消费同名、同类型的 `cmd_vel: Twist` 输入。仍须保留下层的参数校验、动作串行化和零速度停止机制；不要将这些安全逻辑移动到包装器。

### 4. 使用本机 Python GUI（可选）

`dimos-dog-gui` 是一个独立 MCP Host，不绕过下层服务，也不直接使用 Go2 SDK。它默认连接 `http://127.0.0.1:9990/mcp`，界面可修改为另一个受信任 endpoint。输入速度（m/s）和持续时间（s）后，前进和后退按钮各发送一次同名 `tools/call`；停止按钮只发送一次 `stop_motion`，不自动重试。

在 WSLg 或其他可显示 Tkinter 窗口的 Linux 图形会话中，使用已安装 `dimos-dog-mcp` 的 Python 环境运行：

~~~bash
dimos-dog-gui
~~~

若 Ubuntu 缺少 Tkinter，安装 `python3-tk` 后重试。界面的“估算距离”仅为速度乘以时间；它不读取里程计，也不证明机器狗精确移动或到达该距离。GUI 不存储机器人 IP、AES 密钥或运行模式，真机/干跑选择仍由下层 MCP 进程决定。

在 WSL 进行本机真机控制时，可使用 `components/dimos-mcp/scripts/run-go2-mcp.sh` 代替手工导出变量。该脚本只读取 WSL 家目录中的 `$HOME/.config/dimos-dog-mcp/go2.env`，要求该文件权限为 `600`，并使用 WSL 虚拟环境中的 `dimos-dog-mcp` 启动真实 Go2 服务。密钥不能写入仓库；无密钥字段模板为 `components/dimos-mcp/config/go2.env.example`。服务端终端需保持运行，GUI 在另一 WSL 终端通过 `dimos-dog-gui` 启动。

## 接入转发包装器

需要 hook 或 Agent Webhook Gateway 时，包装器是上层应用应连接的 MCP 服务。它默认监听 `http://127.0.0.1:9991/mcp`。同机部署时默认将请求发往 `http://127.0.0.1:9990/mcp`；跨机器部署时必须指向底层机器地址。

在上层机器安装并启动包装器：

~~~powershell
$repositoryPath = "C:/absolute/path/to/pi-hackason"
uv venv --python 3.12
.\.venv\Scripts\Activate.ps1
uv pip install -e "$repositoryPath/components/agent-framework/dimos-mcp-wrapper"
dimos-mcp-wrapper
~~~

POSIX：

~~~bash
repository_path="/absolute/path/to/pi-hackason"
uv venv --python 3.12
source .venv/bin/activate
uv pip install -e "$repository_path/components/agent-framework/dimos-mcp-wrapper"
dimos-mcp-wrapper
~~~

跨主机或使用非默认端口时，在启动包装器前配置：

~~~powershell
$env:DIMOS_MCP_WRAPPER_UPSTREAM_URL = "http://192.168.66.160:9990/mcp"
$env:DIMOS_MCP_WRAPPER_PORT = "9991"
$env:DIMOS_MCP_WRAPPER_TIMEOUT_S = "10"
dimos-mcp-wrapper
~~~

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DIMOS_MCP_WRAPPER_UPSTREAM_URL` | `http://127.0.0.1:9990/mcp` | 下层 MCP 的绝对 HTTP(S) URL，必须包含路径，不能带 query 或 fragment。 |
| `DIMOS_MCP_WRAPPER_PORT` | `9991` | 包装器监听端口。 |
| `DIMOS_MCP_WRAPPER_TIMEOUT_S` | `10.0` | 单次下层请求的超时秒数。 |

包装器只会对每个上层调用发送一次标准 JSON-RPC `tools/call` 请求。网络错误、HTTP 错误或下层 MCP 错误会返回给上层；它不会自动重试任何运动命令。

包装器 `tools/list` 只返回上述 11 个转发工具。DIMOS 自带的 `server_status`、`list_modules` 和 `agent_send` 被包装器公开白名单隐藏。

底层可预期的参数或运动互斥错误使用 `{"status":"error","error":"..."}` 文本 envelope。包装器也识别 DIMOS 对意外异常生成的 `Error running tool '...'` 文本，并将两者都转为上层失败及 `after_error` hook，而不是 `after_success`。

## 接入上层 Agent 或 MCP Host

需要包装器 hook 时，将 MCP Host 指向包装器的 HTTP MCP endpoint：

~~~text
http://包装器主机:9991/mcp
~~~

以 Claude Code 为例：

~~~bash
claude mcp add --transport http --scope project dimos-dog-wrapper http://127.0.0.1:9991/mcp
~~~

其他支持 HTTP MCP 的 Host 也应使用同一端点。Host 发现到的工具名称和参数与下层一致：

| 上层调用 | 参数 | 转发结果 |
| --- | --- | --- |
| `move_forward` | `speed_mps`、`duration_s` | 原样传给下层 `move_forward`。 |
| `move_backward` | `speed_mps`、`duration_s` | 原样传给下层 `move_backward`。 |
| `stop_motion` | 无 | 立即传给下层，不等待或重试 hook。 |
| `motion_status` | 无 | 原样返回下层的本地运动状态。 |
| `tag_location` | `location_name` | 原样传给下层 `tag_location`。 |
| `navigate_with_text` | `query` | 原样传给下层 `navigate_with_text`。 |
| `stop_navigation` | 无 | 取消当前定点导航。 |
| `begin_exploration` | 无 | 启动 Frontier 探索。 |
| `end_exploration` | 无 | 停止 Frontier 探索。 |
| `start_patrol` | 无 | 启动已知地图巡逻。 |
| `stop_patrol` | 无 | 停止已知地图巡逻。 |

建议的上层使用顺序：

1. 首次接入时保持下层 dry-run，先调用 `motion_status`，再按预期参数发起前进或后退请求。
2. 需要提前结束动作时，调用 `stop_motion`；不要依赖断开 MCP 客户端连接来停止机器狗。
3. 实机环境中不要并发发起运动工具调用。收到“动作正在进行”的错误后，先调用 `stop_motion` 或等待当前动作结束。
4. `motion_status` 只描述本地命令执行器，不可当作定位、电量、姿态或碰撞传感器数据。
5. 需要提前结束官方后台行为时，根据当前行为调用 `stop_navigation`、`end_exploration` 或 `stop_patrol`。`stop_motion` 只终止定时速度动作。
6. `begin_exploration` 面向未知区域建图；`start_patrol` 面向已知地图持续移动。两者不能同时运行。

不需要包装器 hook 的独立 MCP Host 也可以直接连接底层机器的 `http://<底层机器IP>:9990/mcp`。Agent Webhook Gateway 当前仍按既定架构连接包装器，不直接连接底层。

## 接入 Agent 输入与最终回复 Webhook

该服务需要 Node.js 22.19 或更高版本，并使用 Pi 已配置的模型和认证。先启动机器狗 MCP 与包装器，再安装并构建网关：

~~~powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/agent-framework/agent-webhook-gateway"
npm ci --ignore-scripts
npm run build
$env:AGENT_WEBHOOK_REPLY_URL = "http://reply-receiver:9080/agent-replies"
node dist/cli.js
~~~

输入端向以下端点提交契约中的 `instruction_id` 和 `text`：

~~~text
POST http://网关主机:8080/v1/instructions
~~~

网关使用 SQLite 持久化 inbox/outbox，默认文件为当前目录下的 `data/agent-webhook.sqlite`；固定 Agent 会话默认持久化到 `data/agent-session`。相同 ID、相同文本的重投返回 `202` 且不会重复运行 Agent；同一 ID 对应不同文本返回 `409`。回复回调失败只重投同一 outbox 事件，不会重新运行 Agent 或 MCP 工具。进程恢复时，已进入处理但没有终态 outbox 的事件会得到固定失败回复，不会被重新执行。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_WEBHOOK_REPLY_URL` | 无 | 回复接收端部署级 HTTP(S) URL，必填。 |
| `AGENT_WEBHOOK_HOST` / `AGENT_WEBHOOK_PORT` | `127.0.0.1` / `8080` | 输入网关监听地址。 |
| `AGENT_WEBHOOK_DATABASE_PATH` | `<cwd>/data/agent-webhook.sqlite` | inbox/outbox SQLite 文件。 |
| `AGENT_WEBHOOK_MCP_URL` | `http://127.0.0.1:9991/mcp` | 包装器 MCP URL。 |
| `AGENT_WEBHOOK_AGENT_DIR` | `~/.pi/agent` | Pi 模型、认证和设置目录。 |
| `AGENT_WEBHOOK_SESSION_DIR` | `<cwd>/data/agent-session` | 固定 Agent 会话目录。 |
| `AGENT_WEBHOOK_DEFAULT_SPEED_MPS` | `0.1` | 仅距离请求的部署标定速度。 |

其余超时和回复重投配置见 `components/agent-framework/agent-webhook-gateway/README.md`。HTTP 请求与回复 schema、停止口令规范化规则及下层开发者验收清单见 [Webhook 对接指南](docs/agent-input-webhook-integration.md)。

## 使用生命周期 hook

包装器会为每次转发投递四种事件：

- `before_call`
- `after_success`
- `after_error`
- `finally`

一个 hook 可以处理全部四种事件；也可以同时注册多个 hook。事件按 FIFO 顺序入队，但由独立后台线程最佳努力处理，因此 hook 不会阻塞 MCP 调用路径。

`before_call` 仅代表事件已入队，不保证 hook 已执行完成，也不是同步授权、拦截或命令改写点。hook 收到的是调用参数的隔离副本；hook 异常仅记录日志，不能改变下层请求、下层结果或下层错误。

示例：通过自定义启动入口接入审计 hook。

~~~python
from dimos_mcp_wrapper.blueprint import build_blueprint
from dimos_mcp_wrapper.hooks import McpCallEvent


class AuditHook:
    def handle(self, event: McpCallEvent) -> None:
        if event.phase == "before_call":
            print(f"queued: {event.call.tool_name}")
        elif event.phase == "after_success":
            print(f"succeeded: {event.call.tool_name}")
        elif event.phase == "after_error":
            print(f"failed: {event.call.tool_name}: {event.error}")
        elif event.phase == "finally":
            print(f"finished: {event.call.tool_name}")


from dimos.core.coordination.module_coordinator import ModuleCoordinator

ModuleCoordinator.build(build_blueprint(hooks=(AuditHook(),))).loop()
~~~

多个 hook 可按以下方式注册：

~~~python
ModuleCoordinator.build(build_blueprint(hooks=(AuditHook(), MetricsHook()))).loop()
~~~

如果未来确定“发送其他指令”的传输协议，应实现明确的 hook 适配器或独立下层适配器。不要提前增加假设性的 `send_instruction` 工具、网络协议或硬件 SDK，更不能将该逻辑做成会阻塞或重试运动调用的 hook。

## 在框架上开发

### 扩展下层能力

新增机器狗能力时，先在 `components/dimos-mcp` 完成能力本身：

1. 定义清晰的 MCP 工具名、参数、返回值和安全边界。
2. 在下层实现参数验证、并发/抢占策略、超时与安全停止；不要依赖上层 Agent 的提示词保证安全。
3. 为纯业务逻辑增加单元测试；在 Python 3.10 至 3.12 且已安装 DIMOS 的环境中，为 MCP 发现或集成行为增加测试。
4. 确认下层能够独立安全运行后，再把它公开给包装器。

### 将新能力暴露到包装器

包装器的职责是透明转发，不是第二个控制器。新增已确认的下层 MCP 工具时：

1. 在 `DogMcpTools` 中添加与下层完全同名、参数完全一致的方法。
2. 在 `McpForwardingSkill` 中添加同名 DIMOS `@skill` 方法。
3. 通过 `ForwardingService` 单次转发；不得改写参数、合成运动结果或自动重试。
4. 如需旁路行为，使用 `McpCallHook`；不得把 hook 用作同步权限判断或停止命令延迟器。
5. 更新本文档中的工具表、配置、接入步骤和扩展说明。若架构边界或安全不变量变化，也要更新 `CONTEXT.md`。

当前关键代码位置：

| 目的 | 位置 |
| --- | --- |
| 下层 DIMOS MCP 组合 | `components/dimos-mcp/src/dimos_dog_mcp/blueprint.py` |
| 下层网络与运行模式配置 | `components/dimos-mcp/src/dimos_dog_mcp/config.py` |
| 下层运动状态机与安全边界 | `components/dimos-mcp/src/dimos_dog_mcp/motion_runtime.py` |
| 下层公开导航契约与 dry-run 行为 | `components/dimos-mcp/src/dimos_dog_mcp/navigation.py` |
| 下层 MCP 工具公开白名单 | `components/dimos-mcp/src/dimos_dog_mcp/server.py` |
| 包装器 MCP 组合 | `components/agent-framework/dimos-mcp-wrapper/src/dimos_mcp_wrapper/blueprint.py` |
| 单次转发与 hook 事件 | `components/agent-framework/dimos-mcp-wrapper/src/dimos_mcp_wrapper/forwarding.py` |
| hook 契约与后台投递 | `components/agent-framework/dimos-mcp-wrapper/src/dimos_mcp_wrapper/hooks.py` |

### 本地验证

两个集成都提供不依赖真实硬件的单元测试。分别在对应目录执行：

~~~powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/dimos-mcp"
$env:PYTHONPATH = "$PWD/src"
python -m unittest discover -s tests -v
~~~

~~~powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/agent-framework/dimos-mcp-wrapper"
$env:PYTHONPATH = "$PWD/src"
python -m unittest discover -s tests -v
~~~

包装器的 DIMOS 原生 `tools/list` 集成测试需要 Python 3.10 至 3.12 和已安装的 DIMOS；不兼容环境会跳过该测试。

要在不安装 DIMOS、不配置模型认证且不连接真实机器狗的环境中复现完整 Webhook → Agent → 包装器 → 底层 MCP → 回复回调链路，运行：

~~~powershell
Set-Location "C:/absolute/path/to/pi-hackason/components/agent-framework/agent-webhook-gateway"
npm ci --ignore-scripts
npm run demo:dry-run
~~~

该演示使用真实网关核心、临时 SQLite 和临时 HTTP 端口，替身化固定 Agent、`dimos-mcp-wrapper`、`dimos-dog-mcp` 与回复接收端；它不会导入 DIMOS 或访问机器狗。命令会断言最终回调、`move_forward`/`stop_motion` 在包装器及底层各调用一次，以及停止口令在普通 Agent 请求仍被阻塞时先完成回调。相同场景已纳入网关的 `npm test`。

## 常见问题

| 现象 | 排查方向 |
| --- | --- |
| 上层看不到工具 | 确认连接的是包装器 `:9991/mcp`，且包装器使用兼容 Python 正常启动。 |
| 包装器报告上游不可用 | 确认下层 `dimos-dog-mcp` 已启动，并检查 `DIMOS_MCP_WRAPPER_UPSTREAM_URL`。 |
| 调用成功但机器狗不动 | 默认是 dry-run；确认是否经过安全预检后显式设置了 `DIMOS_DOG_MCP_MODE=go2`。 |
| 导航工具返回 `required_mode=go2` | 当前下层是 dry-run；完成实机预检并安装 `[go2]` extra 后显式启用 Go2 模式。 |
| 想用 hook 拦截危险动作 | 当前 hook 不是拦截器。应在下层实现明确、可测试的安全策略。 |
| 动作未按预期结束 | 立即调用 `stop_motion`，再检查下层日志和独立急停状态。 |
| 导航、探索或巡逻没有停止 | 调用与当前任务对应的 `stop_navigation`、`end_exploration` 或 `stop_patrol`；`stop_motion` 不取消这些后台任务。 |

## 文档维护规则

`USAGE.md` 是面向框架使用者的公开使用契约。每次新增、删除或改变任何用户可见功能时，变更尚未完成，直到本文档同步更新。至少检查以下内容：

- 工具名称、参数、返回值和安全限制；
- 上下层端点、安装/启动步骤和环境变量；
- hook 生命周期与扩展方式；
- 下层硬件适配方式；
- 外部指令事件和 Agent 回复事件的 Webhook 契约；
- 测试或运行前置条件。

若变更同时影响术语、架构边界或安全不变量，还必须同步更新 `CONTEXT.md`。
