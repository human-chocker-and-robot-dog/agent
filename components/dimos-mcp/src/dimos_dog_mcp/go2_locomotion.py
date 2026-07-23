"""Go2 locomotion initialization required before accepting velocity commands."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol


SPORT_REQUEST_TOPIC = "rt/api/sport/request"
SWITCH_JOYSTICK_API_ID = 1027


class SportRequestConnection(Protocol):
    """The pinned DiMOS Go2 RPC used to call the official Sport API."""

    def publish_request(self, topic: str, data: dict[str, object]) -> object: ...


def enable_go2_locomotion(connection: SportRequestConnection) -> None:
    """Enable the firmware input consumed by DiMOS ``cmd_vel``."""

    response = connection.publish_request(
        SPORT_REQUEST_TOPIC,
        {
            "api_id": SWITCH_JOYSTICK_API_ID,
            "parameter": {"data": True},
        },
    )
    if _response_status_code(response) != 0:
        raise RuntimeError(f"Go2 connection rejected joystick input enablement: {response!r}")


def _response_status_code(response: object) -> int | None:
    if not isinstance(response, Mapping):
        return None
    data = response.get("data")
    if not isinstance(data, Mapping):
        return None
    header = data.get("header")
    if not isinstance(header, Mapping):
        return None
    status = header.get("status")
    if not isinstance(status, Mapping):
        return None
    code = status.get("code")
    if isinstance(code, bool) or not isinstance(code, int):
        return None
    return code
