"""Entry point that composes the motion skills with DIMOS's native MCP server."""

from __future__ import annotations

from dimos.core.coordination.blueprints import autoconnect
from dimos.core.coordination.module_coordinator import ModuleCoordinator
from dimos.core.global_config import global_config

from .agent_bridge import StandaloneAgentBridge
from .config import McpServerConfig, RuntimeMode, read_mcp_server_config, read_runtime_mode
from .dry_run import DryRunTwistSink
from .home import HomeNavigationSkill
from .module import DogMotionSkill
from .navigation import DryRunNavigationSkill
from .server import DogMcpServer
from .stroll import StrollSkill

try:
    from dimos.agents.skills.navigation import NavigationSkillContainer
    from dimos.agents.skills.person_follow import PersonFollowSkillContainer
    from dimos.robot.unitree.go2.blueprints.smart.unitree_go2_spatial import (
        unitree_go2_spatial,
    )
    from dimos.robot.unitree.go2.connection import GO2Connection
    from dimos.robot.unitree.unitree_skill_container import UnitreeSkillContainer
except ModuleNotFoundError:
    NavigationSkillContainer = None
    PersonFollowSkillContainer = None
    unitree_go2_spatial = None
    GO2Connection = None
    UnitreeSkillContainer = None


def build_blueprint():
    """Build an MCP blueprint using dry-run unless Go2 mode is explicitly selected."""

    if read_runtime_mode() is RuntimeMode.GO2:
        return _build_go2_blueprint()
    return autoconnect(
        DryRunTwistSink.blueprint(),
        DogMotionSkill.blueprint(),
        DryRunNavigationSkill.blueprint(),
        DogMcpServer.blueprint(),
    )


def _build_go2_blueprint():
    """Compose the official DIMOS mapping, planning, exploration, and patrol stack."""

    if (
        NavigationSkillContainer is None
        or PersonFollowSkillContainer is None
        or unitree_go2_spatial is None
        or GO2Connection is None
        or UnitreeSkillContainer is None
    ):
        raise RuntimeError(
            "Go2 navigation mode requires the optional dependency; "
            "install dimos-dog-mcp[go2]"
        )

    return autoconnect(
        unitree_go2_spatial,
        NavigationSkillContainer.blueprint(),
        PersonFollowSkillContainer.blueprint(camera_info=GO2Connection.camera_info_static),
        UnitreeSkillContainer.blueprint(),
        HomeNavigationSkill.blueprint(),
        StrollSkill.blueprint(),
        DogMotionSkill.blueprint(),
        StandaloneAgentBridge.blueprint(),
        DogMcpServer.blueprint(),
    )


def configure_mcp_listener(config: McpServerConfig) -> None:
    """Apply the standalone listener configuration to DIMOS."""

    global_config.update(listen_host=config.host, mcp_port=config.port)


def main() -> None:
    """Run the DIMOS module coordinator until the process is stopped."""

    server_config = read_mcp_server_config()
    configure_mcp_listener(server_config)
    print(f"DIMOS dog MCP listening on {server_config.host}:{server_config.port}/mcp")
    ModuleCoordinator.build(build_blueprint()).loop()


if __name__ == "__main__":
    main()
