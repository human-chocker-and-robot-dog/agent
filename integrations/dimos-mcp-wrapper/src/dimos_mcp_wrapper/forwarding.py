"""The thin control-flow layer between MCP tools, hooks, and an upstream client."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from copy import deepcopy

from .hooks import HookDispatcher, McpCall, McpCallEvent, McpCallHook
from .upstream import McpToolClient


class ForwardingService:
    """Forward one MCP tool call while emitting non-blocking lifecycle hooks."""

    def __init__(self, client: McpToolClient, *, hooks: Iterable[McpCallHook] = ()) -> None:
        self._client = client
        self._hooks = HookDispatcher(hooks)

    def forward(self, tool_name: str, arguments: Mapping[str, object]) -> str:
        """Forward exactly once; hook delivery cannot delay or alter the call."""

        upstream_arguments = deepcopy(dict(arguments))
        call = McpCall.create(tool_name, upstream_arguments)
        self._hooks.emit(McpCallEvent(phase="before_call", call=call))
        try:
            result = self._client.call_tool(call.tool_name, upstream_arguments)
        except Exception as error:
            self._hooks.emit(
                McpCallEvent(phase="after_error", call=call, error=str(error))
            )
            raise
        else:
            self._hooks.emit(McpCallEvent(phase="after_success", call=call, result=result))
            return result
        finally:
            self._hooks.emit(McpCallEvent(phase="finally", call=call))

    def close(self) -> None:
        """Stop accepting hook events without blocking motion-control teardown."""

        self._hooks.close()
