"""Restricted DIMOS MCP server for the wrapper's public forwarding contract."""

from __future__ import annotations

from dimos.agents.mcp.mcp_server import McpServer, app
from dimos.core.core import rpc
from dimos.core.module import SkillInfo
from dimos.core.rpc_client import RpcCall, RPCClient


PUBLIC_TOOL_NAMES = frozenset(
    {
        "move_forward",
        "move_backward",
        "stop_motion",
        "motion_status",
        "tag_location",
        "navigate_with_text",
        "stop_navigation",
        "begin_exploration",
        "end_exploration",
        "start_patrol",
        "stop_patrol",
    }
)


class WrapperMcpServer(McpServer):
    """Expose only forwarding tools and hide DIMOS server-management skills."""

    @rpc
    def get_skills(self) -> list[SkillInfo]:
        return []

    @rpc
    def on_system_modules(self, modules: list[RPCClient]) -> None:
        """Restrict DIMOS's dynamic skill registry to the forwarding allowlist."""

        assert self.rpc is not None
        app.state.skills = [
            skill_info
            for module in modules
            for skill_info in (module.get_skills() or [])
            if skill_info.func_name in PUBLIC_TOOL_NAMES
        ]
        app.state.skills_by_name = {skill.func_name: skill for skill in app.state.skills}
        app.state.rpc_calls = {
            skill.func_name: RpcCall(
                None,
                self.rpc,
                skill.func_name,
                skill.class_name,
                [],
            )
            for skill in app.state.skills
        }
