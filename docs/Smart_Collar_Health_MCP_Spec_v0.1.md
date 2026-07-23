# AI 智能项圈 Health MCP 接口规范

> 版本：v0.1  
> 日期：2026-07-23  
> 协议基线：MCP 2025-11-25 稳定版  
> 用途：供项圈侧与 Agent 侧并行开发

## 1. 系统边界

```text
ESP32-C3 / ESP32-S3
→ 项圈采集与算法服务
→ Health MCP Server
→ Agent Runtime
→ 规则层 / 安全状态机
→ DimOS MCP Server
→ Go2
```

Health MCP 回答“人的身体现在是什么状态”。DimOS MCP 回答“机器人能做什么、执行了什么”。

### 项圈侧职责

- 接收 ECG、IMU、设备状态；
- 计算 HR、RR、可选 HRV、ECG 质量和运动状态；
- 生成结构化身体事件；
- 保存实时状态和短期历史；
- 暴露只读 MCP 工具与资源；
- 对过期、低质量或缺失数据明确降级；
- 不直接控制 Go2，不做医学诊断。

### Agent 侧职责

- 连接 Health MCP；
- 收到 Webhook 后查询最新完整状态；
- 检查新鲜度、来源、质量和置信度；
- 将事件映射成有限机器人意图；
- 通过安全状态机后调用 DimOS MCP；
- 记录查询、决策和动作；
- Health MCP 断开时安全降级。

## 2. 传输、版本与鉴权

P0 推荐 Streamable HTTP：

```text
POST http://127.0.0.1:8765/mcp
```

局域网：

```text
POST http://<health-host-ip>:8765/mcp
```

请求头：

```http
MCP-Protocol-Version: 2025-11-25
Authorization: Bearer <token>
```

开发时可监听 `127.0.0.1` 并关闭鉴权。局域网或远程必须使用 Token。Health MCP 与 DimOS MCP 使用不同 Token。

## 3. 公共规则

- 工具名使用小写蛇形命名；
- Schema 使用 `schema_version`；
- 时间使用 UTC ISO 8601；
- 同时保留设备单调时间戳；
- 可缺失生理值必须为 `null`，并附 `unavailable_reason`；
- 结果必须区分 `live`、`replay`、`manual`；
- Agent 不得把 `replay` 或 `manual` 当作实时状态；
- 不通过 MCP 高频传输连续原始 ECG。

## 4. 公共返回包络

成功：

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "schema_version": "0.1",
    "generated_at": "2026-07-23T02:10:00Z",
    "source": "live",
    "age_ms": 420,
    "trace_id": "trace_01J..."
  },
  "error": null
}
```

失败：

```json
{
  "ok": false,
  "data": null,
  "meta": {
    "schema_version": "0.1",
    "generated_at": "2026-07-23T02:10:00Z",
    "source": "live",
    "trace_id": "trace_01J..."
  },
  "error": {
    "code": "STATE_STALE",
    "message": "Latest wearer state is too old.",
    "retryable": true
  }
}
```

错误码：

| code | 含义 | Agent 行为 |
|---|---|---|
| `WEARER_NOT_FOUND` | 佩戴者不存在 | 停止健康动作 |
| `DEVICE_OFFLINE` | 项圈离线 | 不使用旧值 |
| `STATE_STALE` | 数据过期 | 等待或提示连接问题 |
| `SIGNAL_UNRELIABLE` | ECG 不可信 | 禁止健康驱动行为 |
| `FEATURE_UNAVAILABLE` | 指标暂不可用 | 使用其他允许指标 |
| `INVALID_ARGUMENT` | 参数错误 | 修正调用 |
| `INTERNAL_ERROR` | 服务错误 | 记录并降级 |

## 5. WearerState Schema

```json
{
  "schema_version": "0.1",
  "wearer_id": "xwen",
  "timestamp": "2026-07-23T02:10:00Z",
  "device_timestamp_us": 1845023123,
  "source": "live",
  "heart": {
    "heart_rate_bpm": 92,
    "rr_interval_ms": 652,
    "hrv_rmssd_ms": null,
    "hrv_window_s": null,
    "ecg_quality": 0.86,
    "quality_level": "good",
    "lead_off": false,
    "unavailable_reason": null
  },
  "motion": {
    "level": "still",
    "posture": "unknown",
    "head_down": null,
    "confidence": 0.91
  },
  "device": {
    "status": "ok",
    "battery_percent": 74,
    "firmware_version": "0.3.0",
    "packet_loss_ratio_60s": 0.002,
    "last_packet_age_ms": 120
  },
  "confidence": 0.84
}
```

枚举：

```text
quality_level: good | fair | bad | unknown
motion.level: still | light | active | unknown
device.status: ok | degraded | offline
source: live | replay | manual
```

## 6. WearerEvent Schema

```json
{
  "schema_version": "0.1",
  "event_id": "evt_01J...",
  "event_type": "high_hr_low_motion",
  "wearer_id": "xwen",
  "occurred_at": "2026-07-23T02:09:40Z",
  "detected_at": "2026-07-23T02:10:00Z",
  "severity": "info",
  "confidence": 0.82,
  "source": "live",
  "evidence": {
    "heart_rate_bpm": 118,
    "baseline_heart_rate_bpm": 78,
    "duration_s": 25,
    "motion_level": "still",
    "ecg_quality": 0.88,
    "quality_level": "good"
  },
  "recommended_capabilities": [
    "check_in",
    "approach_slowly",
    "wait"
  ],
  "medical_diagnosis": null
}
```

P0 事件：

```text
high_hr_low_motion
signal_unreliable
poor_contact
user_started_moving
user_stopped
```

## 7. MCP Tools

### `get_current_state`

输入：

```json
{
  "wearer_id": "xwen",
  "max_age_ms": 5000
}
```

输出：完整 `WearerState`。

规则：超过 `max_age_ms` 返回 `STATE_STALE`。Agent 处理健康 Webhook 时应首先调用本工具。

### `get_latest_summary`

Agent 常规首选工具。

输入：

```json
{
  "wearer_id": "xwen",
  "max_age_ms": 5000
}
```

输出：

```json
{
  "heart_rate_bpm": 92,
  "ecg_quality": 0.86,
  "quality_level": "good",
  "motion_level": "still",
  "device_status": "ok",
  "active_events": [],
  "confidence": 0.84,
  "source": "live"
}
```

### `get_latest_heart_rate`

输入：

```json
{
  "wearer_id": "xwen",
  "max_age_ms": 5000,
  "require_quality": "fair"
}
```

输出：

```json
{
  "heart_rate_bpm": 92,
  "timestamp": "2026-07-23T02:10:00Z",
  "quality_level": "good",
  "ecg_quality": 0.86,
  "window_s": 10,
  "valid": true
}
```

`require_quality`：`good | fair | any`。

### `get_latest_hrv`

输入：

```json
{
  "wearer_id": "xwen",
  "metric": "rmssd",
  "preferred_window_s": 60,
  "max_age_ms": 15000
}
```

输出：

```json
{
  "metric": "rmssd",
  "value_ms": 42.1,
  "window_s": 72,
  "valid_rr_count": 91,
  "quality_level": "good",
  "confidence": 0.78,
  "valid": true
}
```

P0 可以实现工具但返回 `FEATURE_UNAVAILABLE`。HRV 不阻塞主链。

### `get_ecg_quality`

输入：

```json
{
  "wearer_id": "xwen",
  "window_s": 10
}
```

输出：

```json
{
  "score": 0.86,
  "level": "good",
  "lead_off": false,
  "motion_artifact": false,
  "clipping": false,
  "packet_loss_ratio": 0.002,
  "allowed_outputs": [
    "heart_rate",
    "rr_interval"
  ]
}
```

质量门控：

| 等级 | 允许输出 |
|---|---|
| Good | HR、RR，可选 HRV |
| Fair | HR，暂停或降低 HRV 置信度 |
| Bad | 不输出生理结论 |

### `get_motion_state`

输入：

```json
{
  "wearer_id": "xwen",
  "window_s": 10
}
```

输出：

```json
{
  "level": "still",
  "confidence": 0.91,
  "acceleration_rms": 0.08,
  "gyro_rms": 1.42,
  "posture": "unknown",
  "head_down": null
}
```

P0 只要求 `still / light / active / unknown`。

### `get_recent_events`

输入：

```json
{
  "wearer_id": "xwen",
  "event_types": [
    "high_hr_low_motion",
    "signal_unreliable"
  ],
  "since": "2026-07-23T01:40:00Z",
  "limit": 20
}
```

输出：

```json
{
  "events": [],
  "next_cursor": null
}
```

### `get_event_details`

输入：

```json
{
  "event_id": "evt_01J..."
}
```

输出：完整 `WearerEvent`。

### `get_device_status`

输入：

```json
{
  "wearer_id": "xwen"
}
```

输出：

```json
{
  "status": "ok",
  "connected": true,
  "battery_percent": 74,
  "firmware_version": "0.3.0",
  "transport": "ble",
  "last_packet_age_ms": 120,
  "packet_loss_ratio_60s": 0.002,
  "sampling": {
    "ecg_hz": 250,
    "imu_hz": 50
  }
}
```

## 8. MCP Resources

```text
health://wearers/{wearer_id}/current
health://wearers/{wearer_id}/events/recent
health://wearers/{wearer_id}/device
health://schemas/wearer-state/0.1
health://schemas/wearer-event/0.1
health://system/status
```

不通过 Resource 暴露连续原始 ECG。

## 9. Agent 标准处理流程

```text
1. 验证 Webhook
2. 以 event_id 去重
3. 调 get_event_details
4. 调 get_current_state(max_age_ms=5000)
5. 检查 source == live
6. 检查 device.status == ok
7. 检查 quality_level >= fair
8. 检查 confidence 达到阈值
9. 进入安全状态机
10. 输出有限机器人意图
11. 调用 DimOS MCP
12. 记录结果
```

禁止：

```text
Webhook 一到
→ 不查询最新状态
→ 直接让机器狗移动
```

## 10. 建议动作映射

| 条件 | 允许意图 | 禁止 |
|---|---|---|
| `high_hr_low_motion` + Good | `CHECK_IN`、`APPROACH`、`WAIT` | 快速奔跑、医疗判断 |
| `signal_unreliable` | `WAIT`、提示重新佩戴 | 健康驱动移动 |
| `poor_contact` | `WAIT`、语音提示 | 使用旧心率 |
| `user_stopped` | `STOP`、`WAIT` | 继续领跑 |
| 设备离线或状态过期 | `STOP` | 继续行动 |

## 11. 缓存和调用频率

| 工具 | 最小调用间隔 |
|---|---:|
| `get_latest_summary` | 500 ms |
| `get_current_state` | 500 ms |
| `get_latest_heart_rate` | 1 s |
| `get_latest_hrv` | 10 s |
| `get_recent_events` | 2 s |
| `get_device_status` | 2 s |

Webhook 是事件入口，MCP 是上下文查询入口。不要用 Agent 高频轮询 MCP 代替实时控制器。

## 12. Mock 数据

```json
{
  "schema_version": "0.1",
  "wearer_id": "xwen",
  "timestamp": "2026-07-23T02:10:00Z",
  "source": "manual",
  "heart": {
    "heart_rate_bpm": 118,
    "rr_interval_ms": 508,
    "hrv_rmssd_ms": null,
    "hrv_window_s": null,
    "ecg_quality": 0.88,
    "quality_level": "good",
    "lead_off": false,
    "unavailable_reason": null
  },
  "motion": {
    "level": "still",
    "posture": "standing",
    "head_down": false,
    "confidence": 0.91
  },
  "device": {
    "status": "ok",
    "battery_percent": 74,
    "firmware_version": "mock",
    "packet_loss_ratio_60s": 0,
    "last_packet_age_ms": 0
  },
  "confidence": 0.84
}
```

## 13. 验收

### Health MCP Server

- [ ] 完成 initialize；
- [ ] `tools/list` 返回 P0 工具；
- [ ] `get_latest_summary` 符合 Schema；
- [ ] 离线返回 `DEVICE_OFFLINE`；
- [ ] 过期返回 `STATE_STALE`；
- [ ] ECG Bad 时不输出伪造 HR；
- [ ] 区分 live、replay、manual；
- [ ] 每次调用有 trace_id；
- [ ] 连续运行 30 分钟。

### Agent MCP Client

- [ ] 可连接和重连；
- [ ] 校验 `ok`、`source`、`age_ms` 和质量；
- [ ] MCP 失败时不继续健康动作；
- [ ] Webhook 后会二次查询 MCP；
- [ ] 只输出有限机器人意图；
- [ ] 可从 event_id 追溯到动作。

## 14. 实现顺序

1. Mock Health MCP；
2. Agent 接入 MCP Client；
3. Mock Webhook；
4. Agent 输出模拟机器人动作；
5. 替换真实 `get_latest_summary`；
6. 替换真实 Webhook；
7. 接 DimOS MCP；
8. 最后加入 HRV 和更多事件。
