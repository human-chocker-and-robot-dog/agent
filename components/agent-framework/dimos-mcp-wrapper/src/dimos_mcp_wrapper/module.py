"""DIMOS-native MCP skills that forward to the existing dog MCP."""

from __future__ import annotations

from collections.abc import Iterable

from dimos.agents.annotation import skill
from dimos.core.core import rpc
from dimos.core.module import Module, ModuleConfig

from .config import DEFAULT_TIMEOUT_S, DEFAULT_UPSTREAM_URL
from .dog_tools import DEFAULT_DURATION_S, DEFAULT_SPEED_MPS, DogMcpTools
from .forwarding import ForwardingService
from .hooks import McpCallHook
from .upstream import HttpMcpToolClient, McpToolClient


class McpForwardingSkillConfig(ModuleConfig):
    """DIMOS configuration for the one upstream MCP endpoint."""

    upstream_url: str = DEFAULT_UPSTREAM_URL
    timeout_s: float = DEFAULT_TIMEOUT_S


class McpForwardingSkill(Module):
    """Expose dog tools while delegating their work to the upstream MCP server."""

    config: McpForwardingSkillConfig

    _forwarding: ForwardingService
    _dog_tools: DogMcpTools

    def __init__(
        self,
        *,
        hooks: Iterable[McpCallHook] = (),
        upstream_client: McpToolClient | None = None,
        **kwargs: object,
    ) -> None:
        super().__init__(**kwargs)
        client = upstream_client
        if client is None:
            client = HttpMcpToolClient(
                self.config.upstream_url,
                timeout_s=self.config.timeout_s,
            )
        self._forwarding = ForwardingService(client, hooks=hooks)
        self._dog_tools = DogMcpTools(self._forwarding)

    @rpc
    def stop(self) -> None:
        self._forwarding.close()
        super().stop()

    @skill
    def move_forward(
        self,
        speed_mps: float = DEFAULT_SPEED_MPS,
        duration_s: float = DEFAULT_DURATION_S,
    ) -> str:
        """Forward a bounded forward-motion request to the upstream dog MCP.

        Args:
            speed_mps: Forward speed in m/s; validation remains upstream.
            duration_s: Requested motion duration in seconds; validation remains upstream.
        """

        return self._dog_tools.move_forward(speed_mps, duration_s)

    @skill
    def move_backward(
        self,
        speed_mps: float = DEFAULT_SPEED_MPS,
        duration_s: float = DEFAULT_DURATION_S,
    ) -> str:
        """Forward a bounded reverse-motion request to the upstream dog MCP.

        Args:
            speed_mps: Reverse speed magnitude in m/s; validation remains upstream.
            duration_s: Requested motion duration in seconds; validation remains upstream.
        """

        return self._dog_tools.move_backward(speed_mps, duration_s)

    @skill
    def stop_motion(self) -> str:
        """Immediately forward a stop request; lifecycle hooks never delay it."""

        return self._dog_tools.stop_motion()

    @skill
    def motion_status(self) -> str:
        """Forward the upstream motion-status request without synthesizing telemetry."""

        return self._dog_tools.motion_status()

    @skill
    def tag_location(self, location_name: str) -> str:
        """Tag the robot's current mapped location with a reusable name.

        Args:
            location_name: Human-readable name for the current mapped position.
        """

        return self._dog_tools.tag_location(location_name)

    @skill
    def navigate_with_text(self, query: str) -> str:
        """Resolve a textual destination and start official DIMOS navigation.

        Args:
            query: Natural-language destination or tagged location name.
        """

        return self._dog_tools.navigate_with_text(query)

    @skill
    def stop_navigation(self) -> str:
        """Cancel the active point-to-point navigation goal."""

        return self._dog_tools.stop_navigation()

    @skill
    def begin_exploration(self) -> str:
        """Start official DIMOS wavefront frontier exploration."""

        return self._dog_tools.begin_exploration()

    @skill
    def end_exploration(self) -> str:
        """Stop official DIMOS wavefront frontier exploration."""

        return self._dog_tools.end_exploration()

    @skill
    def start_patrol(self) -> str:
        """Start official DIMOS autonomous patrol over the known map."""

        return self._dog_tools.start_patrol()

    @skill
    def stop_patrol(self) -> str:
        """Stop official DIMOS autonomous patrol."""

        return self._dog_tools.stop_patrol()
