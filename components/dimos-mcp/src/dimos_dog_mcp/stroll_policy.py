"""Pure branch-selection policy for non-exhaustive, human-like strolling."""

from __future__ import annotations

from dataclasses import dataclass
import math
import random


@dataclass(frozen=True)
class StrollCandidate:
    """One reachable unknown-road frontier."""

    branch_id: str
    x: float
    y: float


class StrollPolicy:
    """Choose one local branch, retire its siblings, and avoid backtracking."""

    def __init__(
        self,
        random_source: random.Random | None = None,
        *,
        local_horizon_m: float = 3.0,
        retired_radius_m: float = 1.5,
    ) -> None:
        self._random = random_source or random.Random()
        self._local_horizon_m = local_horizon_m
        self._retired_radius_m = retired_radius_m
        self._heading: tuple[float, float] | None = None
        self._retired: dict[str, tuple[float, float]] = {}

    @property
    def retired_branch_ids(self) -> set[str]:
        return set(self._retired)

    def reset(self) -> None:
        self._heading = None
        self._retired.clear()

    def choose(
        self,
        candidates: list[StrollCandidate],
        *,
        origin_x: float,
        origin_y: float,
    ) -> StrollCandidate | None:
        available = [
            candidate
            for candidate in candidates
            if not self._is_retired(candidate) and self._is_forward(candidate, origin_x, origin_y)
        ]
        if not available:
            return None

        distances = {
            candidate.branch_id: math.hypot(candidate.x - origin_x, candidate.y - origin_y)
            for candidate in available
        }
        nearest = min(distances.values())
        local = [
            candidate
            for candidate in available
            if distances[candidate.branch_id] <= nearest + self._local_horizon_m
        ]
        selected = self._random.choice(local)
        for candidate in local:
            if candidate != selected:
                self._retired[candidate.branch_id] = (candidate.x, candidate.y)

        dx = selected.x - origin_x
        dy = selected.y - origin_y
        magnitude = math.hypot(dx, dy)
        if magnitude > 0.0:
            self._heading = (dx / magnitude, dy / magnitude)
        return selected

    def _is_retired(self, candidate: StrollCandidate) -> bool:
        if candidate.branch_id in self._retired:
            return True
        return any(
            math.hypot(candidate.x - retired_x, candidate.y - retired_y)
            <= self._retired_radius_m
            for retired_x, retired_y in self._retired.values()
        )

    def _is_forward(self, candidate: StrollCandidate, origin_x: float, origin_y: float) -> bool:
        if self._heading is None:
            return True
        dx = candidate.x - origin_x
        dy = candidate.y - origin_y
        return dx * self._heading[0] + dy * self._heading[1] >= 0.0

