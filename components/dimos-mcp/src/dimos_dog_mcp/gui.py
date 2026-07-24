"""Tkinter GUI that calls the standalone DIMOS dog MCP over HTTP."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from itertools import count
import json
import math
from queue import Empty, Queue
from threading import Thread
from tkinter import END, W, Tk, StringVar, Text
from tkinter import ttk
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


DEFAULT_MCP_URL = "http://127.0.0.1:9990/mcp"
DEFAULT_SPEED_MPS = "0.1"
DEFAULT_DURATION_S = "1.0"
DEFAULT_TIMEOUT_S = 10.0


class McpRequestError(RuntimeError):
    """Raised when the MCP endpoint cannot complete one request."""


@dataclass(frozen=True)
class PendingCall:
    """One user-triggered MCP request waiting to run in a worker thread."""

    request_id: int
    endpoint: str
    label: str
    method: str
    params: dict[str, object]
    kind: str


@dataclass(frozen=True)
class CallResult:
    """A completed MCP request delivered back to the Tk event loop."""

    label: str
    kind: str
    response_text: str | None
    error_text: str | None


def parse_positive_number(value: str, field_name: str) -> float:
    """Validate a user-entered positive finite motion parameter."""

    try:
        number = float(value.strip())
    except ValueError as error:
        raise ValueError(f"{field_name} 必须是正数") from error
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"{field_name} 必须是正的有限数值")
    return number


def call_mcp(
    endpoint: str,
    request_id: int,
    method: str,
    params: Mapping[str, object],
    *,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> str:
    """Send one JSON-RPC request and return its human-readable result text."""

    parsed = urlparse(endpoint)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise McpRequestError("MCP 地址必须是完整的 http(s) URL")

    request_body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": dict(params),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(
        endpoint,
        data=request_body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout_s) as response:
            raw_response = response.read().decode("utf-8")
    except HTTPError as error:
        error_body = error.read().decode("utf-8", errors="replace")
        error.close()
        detail = error_body or error.reason
        raise McpRequestError(f"MCP 返回 HTTP {error.code}: {detail}") from error
    except (OSError, TimeoutError, URLError) as error:
        raise McpRequestError(f"MCP 请求失败: {error}") from error

    try:
        decoded: object = json.loads(raw_response)
    except json.JSONDecodeError as error:
        raise McpRequestError("MCP 返回了无效 JSON") from error
    if not isinstance(decoded, dict):
        raise McpRequestError("MCP 响应必须是 JSON 对象")

    error_result = decoded.get("error")
    if isinstance(error_result, Mapping):
        code = error_result.get("code", "unknown")
        message = error_result.get("message", "unknown MCP error")
        raise McpRequestError(f"MCP 错误 {code}: {message}")

    result = decoded.get("result")
    if isinstance(result, Mapping):
        content = result.get("content")
        if isinstance(content, list):
            text_parts = [
                item["text"]
                for item in content
                if isinstance(item, Mapping)
                and item.get("type") == "text"
                and isinstance(item.get("text"), str)
            ]
            if text_parts:
                return _format_result_text("\n".join(text_parts))
        return json.dumps(dict(result), ensure_ascii=False, indent=2)
    return json.dumps(decoded, ensure_ascii=False, indent=2)


def _format_result_text(text: str) -> str:
    """Pretty-print JSON text results while preserving ordinary text results."""

    try:
        decoded: object = json.loads(text)
    except json.JSONDecodeError:
        return text
    return json.dumps(decoded, ensure_ascii=False, indent=2)


class DogMcpGui:
    """A responsive local GUI for directly calling the dog MCP tools."""

    def __init__(self, root: Tk) -> None:
        self._root = root
        self._request_ids = count(1)
        self._results: Queue[CallResult] = Queue()
        self._motion_call_pending = False
        self._stop_call_pending = False
        self._endpoint = StringVar(value=DEFAULT_MCP_URL)
        self._speed_mps = StringVar(value=DEFAULT_SPEED_MPS)
        self._duration_s = StringVar(value=DEFAULT_DURATION_S)
        self._distance_hint = StringVar()
        self._status = StringVar(value="就绪。按钮会直接向 MCP 发送一次工具调用。")
        self._build_widgets()
        self._update_distance_hint()
        self._root.after(100, self._poll_results)

    def _build_widgets(self) -> None:
        self._root.title("DIMOS 机器狗 MCP 控制台")
        self._root.minsize(720, 460)
        self._root.columnconfigure(0, weight=1)
        self._root.rowconfigure(1, weight=1)

        controls = ttk.Frame(self._root, padding=12)
        controls.grid(row=0, column=0, sticky="ew")
        controls.columnconfigure(1, weight=1)

        ttk.Label(controls, text="MCP 地址").grid(row=0, column=0, sticky=W, padx=(0, 8), pady=3)
        ttk.Entry(controls, textvariable=self._endpoint, width=58).grid(
            row=0,
            column=1,
            columnspan=3,
            sticky="ew",
            pady=3,
        )
        ttk.Label(controls, text="速度 (m/s)").grid(row=1, column=0, sticky=W, padx=(0, 8), pady=3)
        speed_entry = ttk.Entry(controls, textvariable=self._speed_mps, width=14)
        speed_entry.grid(row=1, column=1, sticky=W, pady=3)
        ttk.Label(controls, text="持续时间 (s)").grid(
            row=1,
            column=2,
            sticky=W,
            padx=(16, 8),
            pady=3,
        )
        duration_entry = ttk.Entry(controls, textvariable=self._duration_s, width=14)
        duration_entry.grid(row=1, column=3, sticky=W, pady=3)
        speed_entry.bind("<KeyRelease>", self._update_distance_hint)
        duration_entry.bind("<KeyRelease>", self._update_distance_hint)

        ttk.Label(controls, textvariable=self._distance_hint).grid(
            row=2,
            column=0,
            columnspan=4,
            sticky=W,
            pady=(2, 8),
        )

        buttons = ttk.Frame(controls)
        buttons.grid(row=3, column=0, columnspan=4, sticky="ew")
        self._forward_button = ttk.Button(buttons, text="前进", command=self._move_forward)
        self._forward_button.pack(side="left", padx=(0, 8))
        self._backward_button = ttk.Button(buttons, text="后退", command=self._move_backward)
        self._backward_button.pack(side="left", padx=(0, 8))
        self._stop_button = ttk.Button(buttons, text="全部停止", command=self._stop_all)
        self._stop_button.pack(side="left", padx=(0, 8))
        ttk.Button(buttons, text="查询状态", command=self._query_status).pack(side="left", padx=(0, 8))
        ttk.Button(buttons, text="检查连接", command=self._check_connection).pack(side="left")

        ttk.Label(
            controls,
            text="真机模式下，前进和后退按钮会直接调用 MCP；估算距离不是定位或到达保证。",
        ).grid(row=4, column=0, columnspan=4, sticky=W, pady=(8, 0))

        output = ttk.Frame(self._root, padding=(12, 0, 12, 12))
        output.grid(row=1, column=0, sticky="nsew")
        output.columnconfigure(0, weight=1)
        output.rowconfigure(1, weight=1)
        ttk.Label(output, textvariable=self._status).grid(row=0, column=0, sticky=W, pady=(0, 6))
        self._log = Text(output, height=16, wrap="word", state="disabled")
        self._log.grid(row=1, column=0, sticky="nsew")

    def _update_distance_hint(self, _event: object | None = None) -> None:
        try:
            speed = parse_positive_number(self._speed_mps.get(), "速度")
            duration = parse_positive_number(self._duration_s.get(), "持续时间")
        except ValueError:
            self._distance_hint.set("估算距离：请填写正的速度和持续时间")
            return
        self._distance_hint.set(f"估算距离：{speed * duration:.3f} m（速度 × 时间）")

    def _move_forward(self) -> None:
        self._submit_motion("move_forward", "前进")

    def _move_backward(self) -> None:
        self._submit_motion("move_backward", "后退")

    def _submit_motion(self, tool_name: str, label: str) -> None:
        if self._motion_call_pending:
            self._status.set("正在等待上一条运动工具调用返回；不会自动重试。")
            return
        try:
            speed = parse_positive_number(self._speed_mps.get(), "速度")
            duration = parse_positive_number(self._duration_s.get(), "持续时间")
        except ValueError as error:
            self._status.set(str(error))
            return

        self._motion_call_pending = True
        self._set_motion_buttons_enabled(False)
        estimated_distance = speed * duration
        self._status.set(
            f"正在发送{label}：{speed:.3f} m/s，{duration:.3f} s，估算 {estimated_distance:.3f} m。"
        )
        self._submit_call(
            label,
            "tools/call",
            {"name": tool_name, "arguments": {"speed_mps": speed, "duration_s": duration}},
            kind="motion",
        )

    def _stop_all(self) -> None:
        if self._stop_call_pending:
            self._status.set("停止请求正在发送；不会自动重试。")
            return
        self._stop_call_pending = True
        self._stop_button.configure(state="disabled")
        self._status.set("正在发送停止请求。")
        self._submit_call("全部停止", "tools/call", {"name": "stop_all", "arguments": {}}, kind="stop")

    def _query_status(self) -> None:
        self._submit_call("状态查询", "tools/call", {"name": "motion_status", "arguments": {}}, kind="other")

    def _check_connection(self) -> None:
        """Probe the live MCP endpoint without issuing a robot command."""

        self._submit_call("连接检查", "tools/list", {}, kind="other")

    def _submit_call(self, label: str, method: str, params: dict[str, object], *, kind: str) -> None:
        endpoint = self._endpoint.get().strip()
        call = PendingCall(
            request_id=next(self._request_ids),
            endpoint=endpoint,
            label=label,
            method=method,
            params=params,
            kind=kind,
        )
        Thread(target=self._run_call, args=(call,), name=f"dimos-mcp-{call.request_id}", daemon=True).start()

    def _run_call(self, call: PendingCall) -> None:
        try:
            response_text = call_mcp(call.endpoint, call.request_id, call.method, call.params)
        except Exception as error:  # The GUI must surface unexpected worker failures to the user.
            self._results.put(CallResult(call.label, call.kind, None, str(error)))
            return
        self._results.put(CallResult(call.label, call.kind, response_text, None))

    def _poll_results(self) -> None:
        while True:
            try:
                result = self._results.get_nowait()
            except Empty:
                break
            if result.kind == "motion":
                self._motion_call_pending = False
                self._set_motion_buttons_enabled(True)
            elif result.kind == "stop":
                self._stop_call_pending = False
                self._stop_button.configure(state="normal")

            if result.error_text is None:
                self._status.set(f"{result.label}请求已完成。")
                self._append_log(f"{result.label}结果:\n{result.response_text}")
            else:
                self._status.set(f"{result.label}请求失败：{result.error_text}")
                self._append_log(f"{result.label}错误:\n{result.error_text}")
        self._root.after(100, self._poll_results)

    def _set_motion_buttons_enabled(self, enabled: bool) -> None:
        state = "normal" if enabled else "disabled"
        self._forward_button.configure(state=state)
        self._backward_button.configure(state=state)

    def _append_log(self, text: str) -> None:
        timestamp = datetime.now().strftime("%H:%M:%S")
        self._log.configure(state="normal")
        self._log.insert(END, f"[{timestamp}] {text}\n\n")
        self._log.see(END)
        self._log.configure(state="disabled")


def main() -> None:
    """Start the graphical MCP control application."""

    root = Tk()
    DogMcpGui(root)
    root.mainloop()


if __name__ == "__main__":
    main()
