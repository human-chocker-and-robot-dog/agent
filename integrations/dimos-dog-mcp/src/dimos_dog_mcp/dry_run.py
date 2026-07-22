"""A DIMOS cmd_vel sink used when no physical robot is explicitly enabled."""

from __future__ import annotations

from reactivex.disposable import Disposable

from dimos.core.core import rpc
from dimos.core.module import Module
from dimos.core.stream import In
from dimos.msgs.geometry_msgs.Twist import Twist


class DryRunTwistSink(Module):
    """Consumes ``cmd_vel`` without opening a hardware connection."""

    cmd_vel: In[Twist]
    latest_command: Twist | None = None

    @rpc
    def start(self) -> None:
        super().start()
        self.register_disposable(Disposable(self.cmd_vel.subscribe(self._record)))

    @rpc
    def stop(self) -> None:
        super().stop()

    def _record(self, command: Twist) -> None:
        self.latest_command = command
