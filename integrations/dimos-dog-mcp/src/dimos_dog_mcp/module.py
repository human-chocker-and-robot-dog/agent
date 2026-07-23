"""DIMOS skills that implement timed forward, backward, and stop commands."""

from __future__ import annotations

import json
from typing import Any

from dimos.agents.annotation import skill
from dimos.core.core import rpc
from dimos.core.module import Module
from dimos.core.stream import Out
from dimos.msgs.geometry_msgs.Twist import Twist
from dimos.msgs.geometry_msgs.Vector3 import Vector3

from .config import RuntimeMode, read_runtime_mode
from .motion_runtime import (
    DEFAULT_DURATION_S,
    DEFAULT_SPEED_MPS,
    MotionRuntime,
    VelocityCommand,
    validate_motion_request,
)


class DogMotionSkill(Module):
    """Expose timed ``cmd_vel`` motions through the native DIMOS MCP server."""

    cmd_vel: Out[Twist]

    _mode: RuntimeMode
    _runtime: MotionRuntime

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._mode = read_runtime_mode()
        self._runtime = MotionRuntime(self._publish_velocity)

    @rpc
    def start(self) -> None:
        super().start()

    @rpc
    def stop(self) -> None:
        self._runtime.stop()
        super().stop()

    @skill
    def move_forward(
        self,
        speed_mps: float = DEFAULT_SPEED_MPS,
        duration_s: float = DEFAULT_DURATION_S,
    ) -> str:
        """Move forward at the requested speed and duration, then send a zero-velocity stop.

        Args:
            speed_mps: Positive finite forward speed in m/s.
            duration_s: Positive finite motion duration in seconds.
        """

        return self._move("forward", 1.0, speed_mps, duration_s)

    @skill
    def move_backward(
        self,
        speed_mps: float = DEFAULT_SPEED_MPS,
        duration_s: float = DEFAULT_DURATION_S,
    ) -> str:
        """Move backward at the requested speed and duration, then send a zero-velocity stop.

        Args:
            speed_mps: Positive finite reverse speed magnitude in m/s.
            duration_s: Positive finite motion duration in seconds.
        """

        return self._move("backward", -1.0, speed_mps, duration_s)

    @skill
    def stop_motion(self) -> str:
        """Immediately cancel local motion and publish a zero ``cmd_vel`` command.

        The movement executor runs outside the request handler, so this tool
        can preempt a forward or backward command even if DIMOS serializes RPC
        calls for the module.
        """

        was_active = self._runtime.stop()
        status = "stopped" if was_active else "already_idle"
        return json.dumps({"status": status, "zero_velocity_published": True})

    @skill
    def motion_status(self) -> str:
        """Return local motion-command state; this is not a robot telemetry query."""

        status = self._runtime.status()
        return json.dumps(
            {
                "mode": self._mode.value,
                "real_motion_enabled": self._mode is RuntimeMode.GO2,
                "active": status.active,
                "linear_x_mps": status.linear_x,
                "linear_y_mps": status.linear_y,
                "angular_z_radps": status.angular_z,
            }
        )

    def _move(self, direction: str, sign: float, speed_mps: object, duration_s: object) -> str:
        speed, duration = validate_motion_request(speed_mps, duration_s)
        command = VelocityCommand(
            linear_x=sign * speed,
            linear_y=0.0,
            angular_z=0.0,
            duration_s=duration,
        )

        if self._mode is RuntimeMode.DRY_RUN:
            return json.dumps(
                {
                    "status": "dry_run",
                    "direction": direction,
                    "linear_x_mps": command.linear_x,
                    "duration_s": command.duration_s,
                    "message": "No hardware connection was started and no non-zero cmd_vel was published.",
                }
            )

        self._runtime.start(command)
        return json.dumps(
            {
                "status": "started",
                "direction": direction,
                "linear_x_mps": command.linear_x,
                "duration_s": command.duration_s,
                "message": "Call stop_motion to stop before the requested duration expires.",
            }
        )

    def _publish_velocity(self, command: VelocityCommand) -> None:
        self.cmd_vel.publish(
            Twist(
                Vector3(command.linear_x, command.linear_y, 0.0),
                Vector3(0.0, 0.0, command.angular_z),
            )
        )
