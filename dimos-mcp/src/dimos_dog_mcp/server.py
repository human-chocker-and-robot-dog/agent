"""Restricted DIMOS MCP server exposing only robot motion skills."""

from __future__ import annotations

from dimos.agents.mcp.mcp_server import McpServer
from dimos.core.core import rpc
from dimos.core.module import SkillInfo


class DogMcpServer(McpServer):
    """Hide DIMOS server-management skills from the unauthenticated endpoint."""

    @rpc
    def get_skills(self) -> list[SkillInfo]:
        """Exclude this server module's own skills from MCP discovery and calls."""

        return []
