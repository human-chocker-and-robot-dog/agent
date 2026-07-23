"""Minimal AgentSpec provider for the standalone DIMOS MCP process."""

from __future__ import annotations

import json
from threading import Thread
from typing import Any
from urllib.request import Request, urlopen

from langchain_core.messages.base import BaseMessage

from dimos.core.core import rpc
from dimos.core.global_config import global_config
from dimos.core.module import Module
from dimos.utils.logging_config import setup_logger

from .tool_contract import PUBLIC_TOOL_NAMES


logger = setup_logger()


def build_continuation_call(
    continuation: dict[str, Any],
    continuation_context: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    """Validate a DIMOS continuation and substitute its detection variables."""

    tool_name = continuation.get("tool")
    if not isinstance(tool_name, str) or not tool_name:
        raise ValueError("Continuation requires a non-empty 'tool' string")
    if tool_name not in PUBLIC_TOOL_NAMES:
        raise ValueError(f"Continuation tool is not public: {tool_name}")

    raw_arguments = continuation.get("args", {})
    if not isinstance(raw_arguments, dict):
        raise ValueError("Continuation 'args' must be an object")

    arguments: dict[str, Any] = {}
    for name, value in raw_arguments.items():
        if isinstance(value, str) and value.startswith("$"):
            context_name = value[1:]
            arguments[name] = continuation_context.get(context_name, value)
        else:
            arguments[name] = value
    return tool_name, arguments


def build_local_mcp_url(host: str, port: int) -> str:
    """Return an address that reaches the configured listener from the same host."""

    if host == "0.0.0.0":
        host = "127.0.0.1"
    elif host == "::":
        host = "::1"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{port}/mcp"


class StandaloneAgentBridge(Module):
    """Satisfy DIMOS's AgentSpec without embedding an LLM Agent in the lower MCP."""

    @rpc
    def add_message(self, message: BaseMessage) -> None:
        """Record unexpected Agent messages; the upper Agent owns conversation state."""

        logger.warning(
            "Standalone MCP received an Agent message that it cannot consume",
            message_type=type(message).__name__,
        )

    @rpc
    def dispatch_continuation(
        self,
        continuation: dict[str, Any],
        continuation_context: dict[str, Any],
    ) -> None:
        """Schedule a perception continuation through this process's public MCP endpoint."""

        tool_name, arguments = build_continuation_call(
            continuation,
            continuation_context,
        )
        Thread(
            target=self._post_continuation,
            args=(tool_name, arguments),
            name=f"perception-continuation-{tool_name}",
            daemon=True,
        ).start()

    def _post_continuation(self, tool_name: str, arguments: dict[str, Any]) -> None:
        try:
            request = Request(
                build_local_mcp_url(global_config.listen_host, global_config.mcp_port),
                data=json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": "perception-continuation",
                        "method": "tools/call",
                        "params": {
                            "name": tool_name,
                            "arguments": arguments,
                        },
                    }
                ).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(request, timeout=120.0) as response:
                payload = json.loads(response.read())
            if "error" in payload:
                raise RuntimeError(f"MCP continuation failed: {payload['error']}")
        except Exception:
            logger.exception(
                "Failed to dispatch perception continuation",
                tool=tool_name,
                arguments=arguments,
            )
