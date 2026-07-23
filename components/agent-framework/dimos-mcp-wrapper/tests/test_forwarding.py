from __future__ import annotations

import logging
import threading
import unittest

from dimos_mcp_wrapper.forwarding import ForwardingService
from dimos_mcp_wrapper.upstream import UpstreamMcpError


class RecordingClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def call_tool(self, name: str, arguments: dict[str, object]) -> str:
        self.calls.append((name, dict(arguments)))
        return '{"status":"started"}'


class BlockingBeforeHook:
    def __init__(self) -> None:
        self.before_started = threading.Event()
        self.release = threading.Event()

    def handle(self, event: object) -> None:
        if getattr(event, "phase") == "before_call":
            self.before_started.set()
            self.release.wait(timeout=1.0)


class FailingHook:
    def __init__(self) -> None:
        self.called = threading.Event()
        self.finished = threading.Event()
        self._failed = False

    def handle(self, event: object) -> None:
        self.called.set()
        if not self._failed:
            self._failed = True
            raise RuntimeError(f"hook failed during {getattr(event, 'phase')}")
        if getattr(event, "phase") == "finally":
            self.finished.set()


class FailingClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def call_tool(self, name: str, arguments: dict[str, object]) -> str:
        self.calls.append((name, dict(arguments)))
        raise UpstreamMcpError("upstream unavailable")


class NestedMutatingHook:
    def __init__(self) -> None:
        self.mutated = threading.Event()

    def handle(self, event: object) -> None:
        if getattr(event, "phase") != "before_call":
            return
        call = getattr(event, "call")
        metadata = call.arguments["metadata"]
        if not isinstance(metadata, dict):
            raise TypeError("test metadata must be mutable")
        metadata["source"] = "hook"
        self.mutated.set()


class WaitingClient:
    def __init__(self, hook: NestedMutatingHook) -> None:
        self._hook = hook
        self.calls: list[tuple[str, dict[str, object]]] = []

    def call_tool(self, name: str, arguments: dict[str, object]) -> str:
        if not self._hook.mutated.wait(timeout=1.0):
            raise RuntimeError("hook did not run")
        self.calls.append((name, dict(arguments)))
        return "ok"


class ForwardingServiceTests(unittest.TestCase):
    def test_forwarding_does_not_wait_for_a_blocked_before_hook(self) -> None:
        client = RecordingClient()
        hook = BlockingBeforeHook()
        service = ForwardingService(client, hooks=(hook,))
        try:
            result = service.forward(
                "move_backward",
                {"speed_mps": 0.1, "duration_s": 0.5},
            )

            self.assertEqual(result, '{"status":"started"}')
            self.assertEqual(
                client.calls,
                [
                    (
                        "move_backward",
                        {"speed_mps": 0.1, "duration_s": 0.5},
                    )
                ],
            )
            self.assertTrue(hook.before_started.wait(timeout=1.0))
        finally:
            hook.release.set()
            service.close()

    def test_hook_failure_does_not_change_the_upstream_result(self) -> None:
        client = RecordingClient()
        hook = FailingHook()
        service = ForwardingService(client, hooks=(hook,))
        hook_logger = logging.getLogger("dimos_mcp_wrapper.hooks")
        previous_disabled = hook_logger.disabled
        hook_logger.disabled = True
        try:
            result = service.forward("motion_status", {})

            self.assertEqual(result, '{"status":"started"}')
            self.assertEqual(client.calls, [("motion_status", {})])
            self.assertTrue(hook.called.wait(timeout=1.0))
            self.assertTrue(hook.finished.wait(timeout=1.0))
        finally:
            service.close()
            hook_logger.disabled = previous_disabled

    def test_upstream_error_is_not_retried(self) -> None:
        client = FailingClient()
        service = ForwardingService(client)
        try:
            with self.assertRaisesRegex(UpstreamMcpError, "upstream unavailable"):
                service.forward("stop_motion", {})

            self.assertEqual(client.calls, [("stop_motion", {})])
        finally:
            service.close()

    def test_hook_cannot_mutate_nested_arguments_sent_upstream(self) -> None:
        hook = NestedMutatingHook()
        client = WaitingClient(hook)
        service = ForwardingService(client, hooks=(hook,))
        try:
            self.assertEqual(
                service.forward("future_tool", {"metadata": {"source": "caller"}}),
                "ok",
            )

            self.assertEqual(
                client.calls,
                [("future_tool", {"metadata": {"source": "caller"}})],
            )
        finally:
            service.close()
