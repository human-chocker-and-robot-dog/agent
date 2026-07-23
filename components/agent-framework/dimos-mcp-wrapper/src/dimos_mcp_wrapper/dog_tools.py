"""The fixed machine-dog tool surface exposed by the wrapper MCP."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol


DEFAULT_SPEED_MPS = 0.1
DEFAULT_DURATION_S = 1.0


class ToolForwarder(Protocol):
    """The forwarding service contract consumed by the public dog tools."""

    def forward(self, tool_name: str, arguments: Mapping[str, object]) -> str:
        """Forward one named tool call."""


class DogMcpTools:
    """Map the stable dog-tool API to same-named upstream MCP tools."""

    def __init__(self, forwarder: ToolForwarder) -> None:
        self._forwarder = forwarder

    def move_forward(self, speed_mps: float, duration_s: float) -> str:
        """Forward a forward-motion request without changing its arguments."""

        return self._forwarder.forward(
            "move_forward",
            {"speed_mps": speed_mps, "duration_s": duration_s},
        )

    def move_backward(self, speed_mps: float, duration_s: float) -> str:
        """Forward a reverse-motion request without changing its arguments."""

        return self._forwarder.forward(
            "move_backward",
            {"speed_mps": speed_mps, "duration_s": duration_s},
        )

    def stop_motion(self) -> str:
        """Forward an immediate stop request without inserting a retry or delay."""

        return self._forwarder.forward("stop_motion", {})

    def motion_status(self) -> str:
        """Forward the upstream local motion-status request."""

        return self._forwarder.forward("motion_status", {})

    def tag_location(self, location_name: str) -> str:
        """Forward a request to tag the robot's current mapped location."""

        return self._forwarder.forward("tag_location", {"location_name": location_name})

    def navigate_with_text(self, query: str) -> str:
        """Forward a semantic navigation request to the official DIMOS stack."""

        return self._forwarder.forward("navigate_with_text", {"query": query})

    def stop_navigation(self) -> str:
        """Forward cancellation of the active point-to-point navigation goal."""

        return self._forwarder.forward("stop_navigation", {})

    def begin_exploration(self) -> str:
        """Forward startup of DIMOS wavefront frontier exploration."""

        return self._forwarder.forward("begin_exploration", {})

    def end_exploration(self) -> str:
        """Forward cancellation of DIMOS wavefront frontier exploration."""

        return self._forwarder.forward("end_exploration", {})

    def start_patrol(self) -> str:
        """Forward startup of DIMOS autonomous patrol."""

        return self._forwarder.forward("start_patrol", {})

    def stop_patrol(self) -> str:
        """Forward cancellation of DIMOS autonomous patrol."""

        return self._forwarder.forward("stop_patrol", {})
