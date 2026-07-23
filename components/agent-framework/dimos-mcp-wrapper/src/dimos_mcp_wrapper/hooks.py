"""Best-effort lifecycle hooks for forwarded MCP calls."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from copy import deepcopy
from dataclasses import dataclass
import logging
from queue import Queue
from threading import Event, Thread
from types import MappingProxyType
from typing import Literal, Protocol


logger = logging.getLogger(__name__)

HookPhase = Literal["before_call", "after_success", "after_error", "finally"]


@dataclass(frozen=True)
class McpCall:
    """An isolated snapshot of one requested upstream tool call."""

    tool_name: str
    arguments: Mapping[str, object]

    @classmethod
    def create(cls, tool_name: str, arguments: Mapping[str, object]) -> McpCall:
        """Deep-copy arguments so a hook cannot rewrite the forwarded request."""

        return cls(tool_name=tool_name, arguments=MappingProxyType(deepcopy(dict(arguments))))


@dataclass(frozen=True)
class McpCallEvent:
    """A lifecycle event emitted around one upstream tool invocation."""

    phase: HookPhase
    call: McpCall
    result: str | None = None
    error: str | None = None


class McpCallHook(Protocol):
    """Receives best-effort events without participating in control flow."""

    def handle(self, event: McpCallEvent) -> None:
        """Handle a lifecycle event."""


class HookDispatcher:
    """Deliver lifecycle events on a daemon worker, outside the call path."""

    def __init__(self, hooks: Iterable[McpCallHook]) -> None:
        self._hooks = tuple(hooks)
        self._closed = Event()
        self._events: Queue[McpCallEvent | None] = Queue()
        self._worker: Thread | None = None
        if self._hooks:
            self._worker = Thread(
                target=self._run,
                name="dimos-mcp-wrapper-hooks",
                daemon=True,
            )
            self._worker.start()

    def emit(self, event: McpCallEvent) -> None:
        """Queue a lifecycle event without waiting for hook execution."""

        if not self._closed.is_set() and self._hooks:
            self._events.put(event)

    def close(self) -> None:
        """Prevent new hook work; an in-flight hook is never awaited."""

        if not self._closed.is_set():
            self._closed.set()
            self._events.put(None)

    def _run(self) -> None:
        while True:
            event = self._events.get()
            if event is None:
                return
            for hook in self._hooks:
                try:
                    hook.handle(event)
                except Exception:
                    logger.exception(
                        "MCP wrapper hook failed",
                        extra={"phase": event.phase, "tool_name": event.call.tool_name},
                    )
