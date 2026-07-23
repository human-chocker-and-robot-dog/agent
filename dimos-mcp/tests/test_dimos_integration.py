from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import unittest


HAS_SUPPORTED_DIMOS = importlib.util.find_spec("dimos") is not None and sys.version_info < (3, 13)


@unittest.skipUnless(HAS_SUPPORTED_DIMOS, "requires DIMOS on Python 3.10-3.12")
class DimosIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._previous_mode = os.environ.get("DIMOS_DOG_MCP_MODE")
        os.environ["DIMOS_DOG_MCP_MODE"] = "dry-run"

        from dimos.agents.mcp.mcp_adapter import McpAdapter
        from dimos.core.coordination.module_coordinator import ModuleCoordinator
        from dimos.core.global_config import global_config
        from dimos_dog_mcp.blueprint import build_blueprint, configure_mcp_listener
        from dimos_dog_mcp.config import McpServerConfig

        cls._global_config = global_config
        cls._previous_host = global_config.listen_host
        cls._previous_port = global_config.mcp_port
        global_config.update(viewer="none", n_workers=1)
        configure_mcp_listener(McpServerConfig(host="0.0.0.0", port=9990))
        cls._coordinator = ModuleCoordinator.build(build_blueprint())
        cls._adapter = McpAdapter()
        if not cls._adapter.wait_for_ready(timeout=10):
            cls._coordinator.stop()
            raise RuntimeError("DIMOS MCP server did not become ready")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._coordinator.stop()

        cls._global_config.update(
            listen_host=cls._previous_host,
            mcp_port=cls._previous_port,
        )
        if cls._previous_mode is None:
            os.environ.pop("DIMOS_DOG_MCP_MODE", None)
        else:
            os.environ["DIMOS_DOG_MCP_MODE"] = cls._previous_mode

    def tearDown(self) -> None:
        self._adapter.call(
            "tools/call",
            {
                "name": "stop_motion",
                "arguments": {},
            },
        )

    def test_native_mcp_discovers_dry_run_motion_skills(self) -> None:
        result = self._adapter.call("tools/list")
        names = {tool["name"] for tool in result["result"]["tools"]}
        self.assertEqual(
            names,
            {"move_forward", "move_backward", "stop_motion", "motion_status"},
        )

    def test_server_is_running_on_the_configured_remote_listener(self) -> None:
        self.assertEqual(self._global_config.listen_host, "0.0.0.0")
        self.assertEqual(self._global_config.mcp_port, 9990)
        result = self._adapter.call("tools/list")
        self.assertIn("tools", result["result"])

    def test_dry_run_does_not_start_motion(self) -> None:
        result = self._adapter.call(
            "tools/call",
            {
                "name": "move_forward",
                "arguments": {"speed_mps": 0.1, "duration_s": 0.5},
            },
        )
        payload = json.loads(result["result"]["content"][0]["text"])
        self.assertEqual(payload["status"], "dry_run")
        self.assertEqual(payload["linear_x_mps"], 0.1)

    def test_dry_run_rejects_overlapping_motion_with_structured_error(self) -> None:
        first = self._adapter.call(
            "tools/call",
            {
                "name": "move_forward",
                "arguments": {"speed_mps": 0.1, "duration_s": 1.0},
            },
        )
        first_payload = json.loads(first["result"]["content"][0]["text"])
        self.assertEqual(first_payload["status"], "dry_run")

        second = self._adapter.call(
            "tools/call",
            {
                "name": "move_backward",
                "arguments": {"speed_mps": 0.1, "duration_s": 1.0},
            },
        )
        second_payload = json.loads(second["result"]["content"][0]["text"])
        self.assertEqual(second_payload["status"], "error")

        self._adapter.call("tools/call", {"name": "stop_motion", "arguments": {}})

    def test_invalid_motion_uses_structured_error_result(self) -> None:
        result = self._adapter.call(
            "tools/call",
            {
                "name": "move_forward",
                "arguments": {"speed_mps": -0.1, "duration_s": 1.0},
            },
        )
        payload = json.loads(result["result"]["content"][0]["text"])
        self.assertEqual(payload["status"], "error")

    def test_live_mode_maps_backward_motion_to_negative_x_and_stop_to_zero(self) -> None:
        from dimos_dog_mcp.module import DogMotionSkill

        class RecordedOutput:
            def __init__(self) -> None:
                self.messages: list[object] = []
                self.first_nonzero = threading.Event()

            def publish(self, message: object) -> None:
                self.messages.append(message)
                if getattr(getattr(message, "linear"), "x") != 0.0:
                    self.first_nonzero.set()

        previous_mode = os.environ.get("DIMOS_DOG_MCP_MODE")
        os.environ["DIMOS_DOG_MCP_MODE"] = "go2"
        try:
            skill = DogMotionSkill()
            output = RecordedOutput()
            skill.cmd_vel = output

            response = json.loads(skill.move_backward(speed_mps=0.1, duration_s=1.0))
            self.assertEqual(response["status"], "started")
            self.assertTrue(output.first_nonzero.wait(timeout=1.0))
            self.assertLess(getattr(getattr(output.messages[0], "linear"), "x"), 0.0)

            json.loads(skill.stop_motion())
            self.assertEqual(getattr(getattr(output.messages[-1], "linear"), "x"), 0.0)
        finally:
            if previous_mode is None:
                os.environ.pop("DIMOS_DOG_MCP_MODE", None)
            else:
                os.environ["DIMOS_DOG_MCP_MODE"] = previous_mode
