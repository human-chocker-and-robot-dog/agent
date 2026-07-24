"""Unified stopping skill for the live Go2 module graph."""

from __future__ import annotations

from dimos.agents.annotation import skill
from dimos.agents.skills.navigation import NavigationSkillContainer
from dimos.navigation.frontier_exploration.wavefront_frontier_goal_selector import (
    WavefrontFrontierExplorer,
)
from dimos.navigation.patrolling.module import PatrollingModule
from dimos.perception.perceive_loop_skill import PerceiveLoopSkill

from .stop import StopAllSkill
from .stop_actions import run_stop_actions
from .stroll import StrollSkill


class Go2StopAllSkill(StopAllSkill):
    """Stop every activity source in the live Go2 graph."""

    _exploration: WavefrontFrontierExplorer
    _patrol: PatrollingModule
    _stroll: StrollSkill
    _lookout: PerceiveLoopSkill
    _navigation: NavigationSkillContainer

    @skill
    def stop_all(self) -> str:
        """Attempt every stop action, ending with a local zero-velocity stop."""

        return run_stop_actions(
            (
                ("exploration", self._exploration.end_exploration),
                ("patrol", self._patrol.stop_patrol),
                ("stroll", self._stroll.stop_stroll),
                ("lookout", self._lookout.stop_looking_out),
                ("navigation", self._navigation.stop_navigation),
                ("motion", self._motion.stop_motion),
            )
        )
