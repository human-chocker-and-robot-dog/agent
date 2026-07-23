from __future__ import annotations

import random
import unittest

from dimos_dog_mcp.stroll_policy import StrollCandidate, StrollPolicy
from dimos_dog_mcp.tool_contract import PUBLIC_TOOL_NAMES


class StrollPolicyTests(unittest.TestCase):
    def test_versioned_public_contract_contains_20_official_and_7_custom_tools(self) -> None:
        self.assertEqual(len(PUBLIC_TOOL_NAMES), 27)
        self.assertTrue(
            {
                "server_status",
                "observe",
                "start_patrol",
                "return_to_start",
                "start_stroll",
                "stop_stroll",
            }
            <= PUBLIC_TOOL_NAMES
        )
        self.assertNotIn("speak", PUBLIC_TOOL_NAMES)

    def test_randomly_chooses_one_branch_and_retires_its_siblings(self) -> None:
        policy = StrollPolicy(random.Random(7))
        candidates = [
            StrollCandidate("left", 2.0, 1.0),
            StrollCandidate("straight", 3.0, 0.0),
            StrollCandidate("right", 2.0, -1.0),
        ]

        selected = policy.choose(candidates, origin_x=0.0, origin_y=0.0)

        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(policy.retired_branch_ids, {"left", "straight", "right"} - {selected.branch_id})

    def test_never_returns_to_a_retired_branch(self) -> None:
        policy = StrollPolicy(random.Random(3))
        candidates = [
            StrollCandidate("chosen", 2.0, 0.0),
            StrollCandidate("skipped", 2.0, 1.0),
        ]
        selected = policy.choose(candidates, origin_x=0.0, origin_y=0.0)
        assert selected is not None

        later = policy.choose(
            [
                StrollCandidate("skipped", 2.0, 1.0),
                StrollCandidate("continuation", 4.0, 0.2),
            ],
            origin_x=selected.x,
            origin_y=selected.y,
        )

        self.assertIsNotNone(later)
        assert later is not None
        self.assertEqual(later.branch_id, "continuation")

    def test_stops_instead_of_backtracking_when_only_candidates_are_behind(self) -> None:
        policy = StrollPolicy(random.Random(1))
        first = policy.choose(
            [StrollCandidate("forward", 2.0, 0.0)],
            origin_x=0.0,
            origin_y=0.0,
        )
        assert first is not None

        selected = policy.choose(
            [StrollCandidate("behind", -1.0, 0.0)],
            origin_x=first.x,
            origin_y=first.y,
        )

        self.assertIsNone(selected)
