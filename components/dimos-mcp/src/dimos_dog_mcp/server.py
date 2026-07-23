"""Restricted DIMOS MCP server exposing only the framework's public tools."""

from __future__ import annotations

from dimos.agents.mcp.mcp_server import McpServer, app
from dimos.core.core import rpc
from dimos.core.module import SkillInfo
from dimos.core.rpc_client import RpcCall, RPCClient

from .tool_contract import OFFICIAL_MCP_SERVER_TOOL_NAMES, PUBLIC_TOOL_NAMES


class DogMcpServer(McpServer):
    """Publish only the explicit dog MCP contract on the network endpoint."""

    @rpc
    def get_skills(self) -> list[SkillInfo]:
        """Expose the pinned official MCP management tools."""

        return [
            skill_info
            for skill_info in super().get_skills()
            if skill_info.func_name in OFFICIAL_MCP_SERVER_TOOL_NAMES
        ]

    @rpc
    def on_system_modules(self, modules: list[RPCClient]) -> None:
        """Restrict DIMOS's dynamic skill registry to the public allowlist."""

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
