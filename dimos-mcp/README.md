# 独立 DIMOS 机器狗 MCP

`dimos-mcp` 是部署在机器狗侧主机上的独立底层 MCP。它不依赖 Agent Webhook Gateway 或 MCP 包装器运行，只负责把标准 HTTP MCP 工具调用转换为 DIMOS `cmd_vel: Twist`，再交给 dry-run sink 或 Unitree Go2 连接。

```mermaid
flowchart LR
    U["上层机器<br/>Agent / MCP wrapper / MCP Host"] -->|"HTTP MCP"| M["底层机器<br/>dimos-mcp :9990/mcp"]
    M --> S["DogMotionSkill"]
    S -->|"cmd_vel: Twist"| C{"运行模式"}
    C -->|"默认"| D["DryRunTwistSink"]
    C -->|"显式启用"| G["DIMOS GO2Connection"]
    G --> R["Unitree Go2"]
```

## 模块接口

服务暴露以下机器狗工具：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `move_forward` | `speed_mps`、`duration_s` | 按给定速度和时长前进；实机动作结束时发布零速度。 |
| `move_backward` | `speed_mps`、`duration_s` | 按给定速度和时长后退；实机动作结束时发布零速度。 |
| `stop_motion` | 无 | 取消本地运动并立即发布零速度。 |
| `motion_status` | 无 | 返回本地命令执行状态，不是机器狗遥测。 |

速度和时长必须是正有限数值。当前不设置硬编码数值上限；dry-run 和 Go2 都使用同一运动状态机并拒绝重叠运动。可预期的参数或互斥错误返回 `{"status":"error","error":"..."}` 文本结果。MCP 请求返回只表示底层命令处理结果，不证明机器狗已经到达目标位置。

## 运行要求

- Python 3.10 至 3.12，推荐 Python 3.12。
- DIMOS 固定为 `0.0.14b1`。
- 基础安装固定使用 `dimos[web]==0.0.14b1` 和 `langchain-core==1.5.0`。后者是 DIMOS 生成 `@skill` 参数 schema 的实际运行依赖，并处于 DIMOS 声明的兼容范围内。
- 真实 Unitree Go2 需要额外安装 `dimos[unitree]`。
- 跨机器调用要求两台机器之间 TCP 网络可达。
- 当前 MCP 没有身份认证，只能暴露在受信任网络中。

## 在底层机器安装

将根目录 `dimos-mcp` 文件夹复制到机器狗侧主机。它是独立 Python 包，不需要复制仓库中的 `packages/`、Agent 网关或包装器。

POSIX：

```bash
cd /absolute/path/to/dimos-mcp
uv venv --python 3.12
source .venv/bin/activate
uv pip install -e .
```

PowerShell：

```powershell
Set-Location "C:/absolute/path/to/dimos-mcp"
uv venv --python 3.12
.\.venv\Scripts\Activate.ps1
uv pip install -e .
```

## 本机 dry-run

不设置运行模式时默认为 dry-run。默认只监听本机回环地址：

```bash
dimos-dog-mcp
```

默认 endpoint：

```text
http://127.0.0.1:9990/mcp
```

dry-run 不连接、站立或移动真实机器狗。`move_forward` 和 `move_backward` 会返回计划参数，但不会发布非零 `cmd_vel`。

## 暴露给另一台机器

在底层机器显式监听所有 IPv4 interface：

POSIX：

```bash
export DIMOS_DOG_MCP_HOST=0.0.0.0
export DIMOS_DOG_MCP_PORT=9990
dimos-dog-mcp
```

PowerShell：

```powershell
$env:DIMOS_DOG_MCP_HOST = "0.0.0.0"
$env:DIMOS_DOG_MCP_PORT = "9990"
dimos-dog-mcp
```

`0.0.0.0` 只用于监听，不能写进上层调用 URL。假设底层机器局域网地址为 `192.168.66.160`，上层使用：

```text
http://192.168.66.160:9990/mcp
```

若主机防火墙阻止连接，只允许上层机器所在受信任网段访问 TCP 9990。不要对公网开放该端口。

Ubuntu UFW 示例：

```bash
sudo ufw allow from 192.168.66.0/24 to any port 9990 proto tcp
```

Windows 防火墙示例：

```powershell
New-NetFirewallRule `
    -DisplayName "DIMOS MCP trusted LAN" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 9990 `
    -RemoteAddress "192.168.66.0/24" `
    -Action Allow
```

防火墙规则应按实际上层 IP 或受信任网段收紧。

## 从上层机器验证

### 初始化

```bash
curl --request POST "http://192.168.66.160:9990/mcp" \
  --header "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"remote-check","version":"0.1.0"}}}'
```

### 发现工具

```bash
curl --request POST "http://192.168.66.160:9990/mcp" \
  --header "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

返回的 `tools` 必须只包含：

```text
move_forward
move_backward
stop_motion
motion_status
```

独立 Server 会隐藏 DIMOS 自带的 `server_status`、`list_modules` 和 `agent_send`，避免扩大无认证远程 endpoint 的能力范围。

### dry-run 前进调用

```bash
curl --request POST "http://192.168.66.160:9990/mcp" \
  --header "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"move_forward","arguments":{"speed_mps":0.1,"duration_s":1.0}}}'
```

dry-run 工具文本包含：

```json
{
  "status": "dry_run",
  "direction": "forward",
  "linear_x_mps": 0.1,
  "duration_s": 1.0
}
```

### 查询状态

```bash
curl --request POST "http://192.168.66.160:9990/mcp" \
  --header "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"motion_status","arguments":{}}}'
```

## 上层接入方式

### 直接 MCP Host

支持 HTTP MCP 的 Host 可以直接连接底层 endpoint。例如：

```bash
claude mcp add --transport http --scope project dimos-dog http://192.168.66.160:9990/mcp
```

### 通过本项目包装器

如果上层需要 `before_call`、`after_success`、`after_error` 和 `finally` hook，应在上层机器运行 `integrations/dimos-mcp-wrapper`：

```powershell
$env:DIMOS_MCP_WRAPPER_UPSTREAM_URL = "http://192.168.66.160:9990/mcp"
$env:DIMOS_MCP_WRAPPER_PORT = "9991"
dimos-mcp-wrapper
```

此时 Agent 或 MCP Host 连接上层机器的包装器：

```text
http://127.0.0.1:9991/mcp
```

底层 MCP 不需要知道包装器、Agent 或用户输入 Webhook 的地址。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DIMOS_DOG_MCP_HOST` | `127.0.0.1` | DIMOS MCP HTTP 监听地址。跨机器调用时设置为 `0.0.0.0` 或指定底层 interface 地址。 |
| `DIMOS_DOG_MCP_PORT` | `9990` | MCP TCP 端口，必须是 1 至 65535 的整数。 |
| `DIMOS_DOG_MCP_MODE` | `dry-run` | `dry-run` 或 `go2`。只有 `go2` 会连接真实硬件。 |
| `ROBOT_IP` | 无 | DIMOS Go2 连接使用的机器狗地址；只在 `go2` 模式中需要。 |

启动时配置非法会直接失败，不会回退到其他地址、端口或实机模式。

## 启用真实 Unitree Go2

完成场地隔离、独立急停、低延迟网络和 DIMOS/Unitree 网络预检后，在底层机器安装 Go2 extra：

```bash
cd /absolute/path/to/dimos-mcp
source .venv/bin/activate
uv pip install -e '.[go2]'
```

然后显式启动：

```bash
export ROBOT_IP=<YOUR_GO2_IP>
export DIMOS_DOG_MCP_MODE=go2
export DIMOS_DOG_MCP_HOST=0.0.0.0
export DIMOS_DOG_MCP_PORT=9990
dimos-dog-mcp
```

Go2 模式复用 DIMOS 官方 `GO2Connection`。正常到期、显式停止和模块关闭都会发布零速度。MCP 客户端断开不等同于动作取消；需要提前停止时必须调用 `stop_motion`。

非 Go2 设备应在底层包中替换或扩展 DIMOS 连接 module，使其消费同名、同类型的 `cmd_vel: Twist`，同时保留参数验证、运动互斥和零速度停止。

## 测试

纯运动状态机和配置测试不依赖 DIMOS：

```powershell
Set-Location "C:/absolute/path/to/dimos-mcp"
$env:PYTHONPATH = "$PWD/src"
python -m unittest discover -s tests -v
```

DIMOS 集成测试要求 Python 3.10 至 3.12 且已安装项目依赖。Python 3.13 及更高版本会跳过这些集成测试。

## 部署边界

- 一个底层 MCP 进程对应一个本地运动执行器。
- 不要同时运行多个进程控制同一台机器狗。
- 默认 dry-run 是安装安全默认值，不代表真实 Go2 链路已经验证。
- `motion_status` 是进程内命令状态，不是遥测。
- MCP 没有认证、授权、签名、速率限制或公网防护。
- 上层连接中断不会自动触发 `stop_motion`。
- 上层不得自动重试运动工具；网络状态不确定时先查询状态或停止，再由用户决定下一步。
