"""Session-scoped automatic start-pose capture and return navigation."""

from __future__ import annotations

from copy import deepcopy
import json
import math
from threading import RLock

from reactivex.disposable import Disposable

from dimos.agents.annotation import skill
from dimos.agents.capabilities import CAP_MOVEMENT
from dimos.core.core import rpc
from dimos.core.module import Module
from dimos.core.stream import In
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.navigation.navigation_spec import NavigationInterfaceSpec


START_TOLERANCE_M = 0.2


class HomeNavigationSkill(Module):
    """Remember the first valid odometry pose and navigate back to it on request."""

    odom: In[PoseStamped]
    _navigation: NavigationInterfaceSpec

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._start_pose: PoseStamped | None = None
        self._latest_odom: PoseStamped | None = None
        self._pose_lock = RLock()

    @rpc
    def start(self) -> None:
        super().start()
        self.register_disposable(Disposable(self.odom.subscribe(self._capture_odometry)))

    @property
    def start_pose(self) -> PoseStamped:
        """Return a defensive copy of the captured start pose."""

        with self._pose_lock:
            if self._start_pose is None:
                raise RuntimeError("No valid start pose has been captured")
            return deepcopy(self._start_pose)

    def _capture_odometry(self, pose: PoseStamped) -> None:
        if not self._is_valid_pose(pose):
            return

        with self._pose_lock:
            self._latest_odom = deepcopy(pose)
            if self._start_pose is None:
                self._start_pose = deepcopy(pose)

    @skill(uses=[CAP_MOVEMENT])
    def return_to_start(self) -> str:
        """Navigate to the first valid odometry pose captured in this process."""

        with self._pose_lock:
            start_pose = deepcopy(self._start_pose)
            latest_odom = deepcopy(self._latest_odom)

        if start_pose is None or latest_odom is None:
            return self._result(
                {
                    "status": "error",
                    "error": "No valid session start pose has been captured yet.",
                }
            )

        distance_m = latest_odom.position.distance(start_pose.position)
        if distance_m <= START_TOLERANCE_M:
            return self._result(
                {
                    "status": "already_at_start",
                    "distance_m": distance_m,
                    "tolerance_m": START_TOLERANCE_M,
                    "message": "The robot is already within the start-position tolerance.",
                }
            )

        self._navigation.set_goal(start_pose)
        return self._result(
            {
                "status": "started",
                "distance_m": distance_m,
                "tolerance_m": START_TOLERANCE_M,
                "message": "Started navigating to the session start pose.",
            }
        )

    @staticmethod
    def _is_valid_pose(pose: PoseStamped) -> bool:
        values = (
            pose.position.x,
            pose.position.y,
            pose.position.z,
            pose.orientation.x,
            pose.orientation.y,
            pose.orientation.z,
            pose.orientation.w,
        )
        return all(math.isfinite(value) for value in values)

    @staticmethod
    def _result(payload: dict[str, object]) -> str:
        return json.dumps(payload, ensure_ascii=False)
