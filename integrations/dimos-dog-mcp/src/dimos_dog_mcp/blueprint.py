"""Entry point that composes the motion skills with DIMOS's native MCP server."""

from __future__ import annotations

from dimos.agents.mcp.mcp_server import McpServer
from dimos.core.coordination.blueprints import autoconnect

from .config import RuntimeMode, read_runtime_mode
from .dry_run import DryRunTwistSink
from .module import DogMotionSkill


def build_blueprint():
    """Build an MCP blueprint using dry-run unless Go2 mode is explicitly selected."""

    if read_runtime_mode() is RuntimeMode.GO2:
        from dimos.robot.unitree.go2.connection import GO2Connection

        base = GO2Connection.blueprint()
    else:
        base = DryRunTwistSink.blueprint()
    return autoconnect(
        base,
        DogMotionSkill.blueprint(),
        McpServer.blueprint(),
    )


def main() -> None:
    """Run the DIMOS module coordinator until the process is stopped."""

    build_blueprint().build().loop()


if __name__ == "__main__":
    main()
