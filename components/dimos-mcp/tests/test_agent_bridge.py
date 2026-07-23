from __future__ import annotations

import importlib.util
import json
import sys
from threading import Event
import unittest
from unittest.mock import patch


HAS_SUPPORTED_DIMOS = importlib.util.find_spec("dimos") is not None and sys.version_info < (3, 13)


@unittest.skipUnless(HAS_SUPPORTED_DIMOS, "requires DIMOS on Python 3.10-3.12")
class AgentBridgeTests(unittest.TestCase):
    def test_dispatch_posts_one_public_tool_call_to_local_mcp(self) -> None:
        from dimos_dog_mcp.agent_bridge import StandaloneAgentBridge

        class Response:
            completed = Event()

            def __enter__(self) -> Response:
                return self

            def __exit__(self, *args: object) -> None:
                self.completed.set()
                return None

            def read(self) -> bytes:
                return b'{"jsonrpc":"2.0","id":"perception-continuation","result":{}}'

        bridge = StandaloneAgentBridge()
        with patch("dimos_dog_mcp.agent_bridge.urlopen", return_value=Response()) as request:
            bridge.dispatch_continuation(
                {
                    "tool": "navigate_with_text",
                    "args": {
                        "query": "$label",
                    },
                },
                {"label": "walker"},
            )
            self.assertTrue(Response.completed.wait(timeout=1.0))
            self.assertEqual(request.call_count, 1)
            http_request = request.call_args.args[0]
        self.assertEqual(http_request.full_url, "http://127.0.0.1:9990/mcp")
        self.assertEqual(
            json.loads(http_request.data),
            {
                "jsonrpc": "2.0",
                "id": "perception-continuation",
                "method": "tools/call",
                "params": {
                    "name": "navigate_with_text",
                    "arguments": {"query": "walker"},
                },
            },
        )

    def test_local_mcp_url_uses_a_reachable_address_for_wildcard_listeners(self) -> None:
        from dimos_dog_mcp.agent_bridge import build_local_mcp_url

        self.assertEqual(build_local_mcp_url("0.0.0.0", 9990), "http://127.0.0.1:9990/mcp")
        self.assertEqual(build_local_mcp_url("::", 9990), "http://[::1]:9990/mcp")
        self.assertEqual(
            build_local_mcp_url("192.168.66.160", 9990),
            "http://192.168.66.160:9990/mcp",
        )

    def test_continuation_substitutes_detection_context(self) -> None:
        from dimos_dog_mcp.agent_bridge import build_continuation_call

        name, arguments = build_continuation_call(
            {
                "tool": "navigate_with_text",
                "args": {
                    "query": "$label",
                },
            },
            {
                "label": "walker",
                "bbox": [1, 2, 3, 4],
            },
        )

        self.assertEqual(name, "navigate_with_text")
        self.assertEqual(
            arguments,
            {
                "query": "walker",
            },
        )

    def test_continuation_rejects_non_public_tool(self) -> None:
        from dimos_dog_mcp.agent_bridge import build_continuation_call

        with self.assertRaisesRegex(ValueError, "not public"):
            build_continuation_call(
                {"tool": "private_internal_tool", "args": {}},
                {},
            )

    def test_dispatch_rejects_non_public_tool_before_starting_a_thread(self) -> None:
        from dimos_dog_mcp.agent_bridge import StandaloneAgentBridge

        bridge = StandaloneAgentBridge()
        with patch("dimos_dog_mcp.agent_bridge.Thread") as thread:
            with self.assertRaisesRegex(ValueError, "not public"):
                bridge.dispatch_continuation(
                    {"tool": "private_internal_tool", "args": {}},
                    {},
                )
        thread.assert_not_called()


if __name__ == "__main__":
    unittest.main()
