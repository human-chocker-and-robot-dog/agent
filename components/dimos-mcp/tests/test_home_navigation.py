from __future__ import annotations

import json
import math
import unittest

from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from dimos.msgs.geometry_msgs.Quaternion import Quaternion
from dimos.msgs.geometry_msgs.Vector3 import make_vector3

from dimos_dog_mcp.home import HomeNavigationSkill


def make_pose(x: float, y: float, yaw: float = 0.0) -> PoseStamped:
    return PoseStamped(
        position=make_vector3(x, y, 0.0),
        orientation=Quaternion.from_euler(make_vector3(0.0, 0.0, yaw)),
        frame_id="map",
    )


class RecordedNavigation:
    def __init__(self) -> None:
        self.goals: list[PoseStamped] = []

    def set_goal(self, goal: PoseStamped) -> bool:
        self.goals.append(goal)
        return True


class HomeNavigationSkillTests(unittest.TestCase):
    def test_first_valid_odometry_is_kept_as_the_session_start_pose(self) -> None:
        skill = HomeNavigationSkill()
        skill._capture_odometry(make_pose(math.nan, 0.0))
        skill._capture_odometry(make_pose(1.0, 2.0, 0.3))
        skill._capture_odometry(make_pose(4.0, 5.0, 0.6))

        self.assertEqual(skill.start_pose.position.x, 1.0)
        self.assertEqual(skill.start_pose.position.y, 2.0)
        self.assertAlmostEqual(skill.start_pose.orientation.euler.z, 0.3)

    def test_return_to_start_reports_missing_odometry_without_setting_a_goal(self) -> None:
        navigation = RecordedNavigation()
        skill = HomeNavigationSkill()
        skill._navigation = navigation

        result = json.loads(skill.return_to_start())

        self.assertEqual(result["status"], "error")
        self.assertEqual(navigation.goals, [])

    def test_return_to_start_short_circuits_inside_twenty_centimetres(self) -> None:
        navigation = RecordedNavigation()
        skill = HomeNavigationSkill()
        skill._navigation = navigation
        skill._capture_odometry(make_pose(1.0, 2.0, 0.3))
        skill._capture_odometry(make_pose(1.19, 2.0, 1.2))

        result = json.loads(skill.return_to_start())

        self.assertEqual(result["status"], "already_at_start")
        self.assertAlmostEqual(result["distance_m"], 0.19)
        self.assertEqual(navigation.goals, [])

    def test_return_to_start_sends_the_original_pose_when_outside_tolerance(self) -> None:
        navigation = RecordedNavigation()
        skill = HomeNavigationSkill()
        skill._navigation = navigation
        skill._capture_odometry(make_pose(1.0, 2.0, 0.3))
        skill._capture_odometry(make_pose(1.21, 2.0, 1.2))

        result = json.loads(skill.return_to_start())

        self.assertEqual(result["status"], "started")
        self.assertEqual(len(navigation.goals), 1)
        self.assertEqual(navigation.goals[0].position.x, 1.0)
        self.assertEqual(navigation.goals[0].position.y, 2.0)
        self.assertAlmostEqual(navigation.goals[0].orientation.euler.z, 0.3)


if __name__ == "__main__":
    unittest.main()
