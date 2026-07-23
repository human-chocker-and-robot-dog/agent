from __future__ import annotations

import unittest

from dimos_mcp_wrapper.dog_tools import DogMcpTools


class RecordingForwarder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []

    def forward(self, tool_name: str, arguments: dict[str, object]) -> str:
        self.calls.append((tool_name, dict(arguments)))
        return tool_name


class DogMcpToolsTests(unittest.TestCase):
    def test_dog_commands_forward_to_the_matching_upstream_tool(self) -> None:
        forwarder = RecordingForwarder()
        tools = DogMcpTools(forwarder)

        self.assertEqual(tools.move_forward(0.12, 0.4), "move_forward")
        self.assertEqual(tools.move_backward(0.08, 0.3), "move_backward")
        self.assertEqual(tools.stop_motion(), "stop_motion")
        self.assertEqual(tools.motion_status(), "motion_status")
        self.assertEqual(tools.tag_location("门口"), "tag_location")
        self.assertEqual(tools.navigate_with_text("去门口"), "navigate_with_text")
        self.assertEqual(tools.stop_navigation(), "stop_navigation")
        self.assertEqual(tools.begin_exploration(), "begin_exploration")
        self.assertEqual(tools.end_exploration(), "end_exploration")
        self.assertEqual(tools.start_patrol(), "start_patrol")
        self.assertEqual(tools.stop_patrol(), "stop_patrol")

        self.assertEqual(
            forwarder.calls,
            [
                ("move_forward", {"speed_mps": 0.12, "duration_s": 0.4}),
                ("move_backward", {"speed_mps": 0.08, "duration_s": 0.3}),
                ("stop_motion", {}),
                ("motion_status", {}),
                ("tag_location", {"location_name": "门口"}),
                ("navigate_with_text", {"query": "去门口"}),
                ("stop_navigation", {}),
                ("begin_exploration", {}),
                ("end_exploration", {}),
                ("start_patrol", {}),
                ("stop_patrol", {}),
            ],
        )
