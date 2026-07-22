"""Runtime configuration for the DIMOS dog MCP extension."""

from __future__ import annotations

from collections.abc import Mapping
from enum import Enum
import os


class RuntimeMode(str, Enum):
    """The connection selected for the motion skills."""

    DRY_RUN = "dry-run"
    GO2 = "go2"


def read_runtime_mode(env: Mapping[str, str] | None = None) -> RuntimeMode:
    """Read the explicitly selected DIMOS dog connection mode.

    The default is deliberately dry-run so installing or starting the MCP
    process never connects to, stands up, or moves a physical robot.
    """

    source = os.environ if env is None else env
    raw_mode = source.get("DIMOS_DOG_MCP_MODE", RuntimeMode.DRY_RUN.value).strip().lower()
    try:
        return RuntimeMode(raw_mode)
    except ValueError as error:
        allowed = ", ".join(mode.value for mode in RuntimeMode)
        raise ValueError(f"DIMOS_DOG_MCP_MODE must be one of: {allowed}; got {raw_mode!r}") from error
