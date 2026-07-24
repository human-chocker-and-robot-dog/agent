"""Human-like, deliberately non-exhaustive frontier strolling for Go2 mode."""

from __future__ import annotations

from dimos.agents.annotation import skill
from dimos.agents.capabilities import CAP_MOVEMENT
from dimos.core.core import rpc
from dimos.msgs.geometry_msgs.Vector3 import Vector3
from dimos.msgs.nav_msgs.OccupancyGrid import OccupancyGrid
from dimos.navigation.frontier_exploration.wavefront_frontier_goal_selector import (
    WavefrontFrontierExplorer,
)

from .stroll_policy import StrollCandidate, StrollPolicy


class StrollSkill(WavefrontFrontierExplorer):
    """Follow one randomly chosen frontier branch without coverage backtracking."""

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._stroll_policy = StrollPolicy()

    def begin_exploration(self) -> str:
        """This subclass exposes start_stroll instead of another exploration tool."""

        return "Use start_stroll."

    def end_exploration(self) -> str:
        """Direct callers should use the unified public stop tool."""

        return "Use stop_all."

    @skill(uses=[CAP_MOVEMENT], lifecycle="background")
    def start_stroll(self) -> str:
        """Start a non-exhaustive stroll that randomly commits to one unknown branch."""

        self.start_tool("start_stroll")
        if self.exploration_active:
            return "Stroll is already running. Use `stop_all` to stop."
        self.reset_exploration_session()
        self.explore()
        return "Stroll started. Use `stop_all` to stop."

    @rpc
    def stop_stroll(self) -> str:
        """Stop the ongoing human-like stroll."""

        self.stop_exploration()
        self.stop_tool("start_stroll")
        return "Stroll stopped."

    def reset_exploration_session(self) -> None:
        super().reset_exploration_session()
        self._stroll_policy.reset()

    def get_exploration_goal(
        self,
        robot_pose: Vector3,
        costmap: OccupancyGrid,
    ) -> Vector3 | None:
        frontiers = self.detect_frontiers(robot_pose, costmap)
        candidates = [
            StrollCandidate(
                branch_id=f"{frontier.x:.1f}:{frontier.y:.1f}",
                x=float(frontier.x),
                y=float(frontier.y),
            )
            for frontier in frontiers
        ]
        selected = self._stroll_policy.choose(
            candidates,
            origin_x=float(robot_pose.x),
            origin_y=float(robot_pose.y),
        )
        if selected is None:
            self.exploration_active = False
            return None
        goal = Vector3(selected.x, selected.y, 0.0)
        self._update_exploration_direction(robot_pose, goal)
        self.mark_explored_goal(goal)
        self.last_costmap = costmap
        return goal

    def _exploration_loop(self) -> None:
        try:
            self._run_exploration_loop()
        finally:
            self.stop_tool("start_stroll")
