"""Stable navigation skill surface for dry-run and the official Go2 stack."""

from __future__ import annotations

import json

from dimos.agents.annotation import skill
from dimos.core.module import Module


NAVIGATION_TOOL_NAMES = frozenset(
    {
        "tag_location",
        "navigate_with_text",
        "stop_navigation",
        "begin_exploration",
        "end_exploration",
        "start_patrol",
        "stop_patrol",
    }
)


class DryRunNavigationSkill(Module):
    """Expose the navigation contract without pretending to navigate in dry-run."""

    @skill
    def tag_location(self, location_name: str) -> str:
        """Report that location tagging requires the live Go2 navigation stack."""

        return self._unavailable("tag_location", {"location_name": location_name})

    @skill
    def navigate_with_text(self, query: str) -> str:
        """Report that semantic navigation requires the live Go2 navigation stack."""

        return self._unavailable("navigate_with_text", {"query": query})

    @skill
    def stop_navigation(self) -> str:
        """Report that no live navigation stack is active in dry-run."""

        return self._unavailable("stop_navigation")

    @skill
    def begin_exploration(self) -> str:
        """Report that autonomous exploration requires the live Go2 stack."""

        return self._unavailable("begin_exploration")

    @skill
    def end_exploration(self) -> str:
        """Report that no live exploration process is active in dry-run."""

        return self._unavailable("end_exploration")

    @skill
    def start_patrol(self) -> str:
        """Report that autonomous patrol requires the live Go2 stack."""

        return self._unavailable("start_patrol")

    @skill
    def stop_patrol(self) -> str:
        """Report that no live patrol process is active in dry-run."""

        return self._unavailable("stop_patrol")

    @staticmethod
    def _unavailable(tool_name: str, arguments: dict[str, object] | None = None) -> str:
        return json.dumps(
            {
                "status": "error",
                "error": f"{tool_name} requires DIMOS_DOG_MCP_MODE=go2",
                "required_mode": "go2",
                "arguments": arguments or {},
            },
            ensure_ascii=False,
        )
