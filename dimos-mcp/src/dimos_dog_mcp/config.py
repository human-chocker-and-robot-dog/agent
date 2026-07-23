"""Runtime and network configuration for the standalone DIMOS dog MCP."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
import os


DEFAULT_MCP_HOST = "127.0.0.1"
DEFAULT_MCP_PORT = 9990


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


@dataclass(frozen=True)
class McpServerConfig:
    """The HTTP interface exposed by the DIMOS MCP server."""

    host: str
    port: int


def read_mcp_server_config(env: Mapping[str, str] | None = None) -> McpServerConfig:
    """Read and validate the standalone MCP HTTP listener configuration."""

    source = os.environ if env is None else env
    host = source.get("DIMOS_DOG_MCP_HOST", DEFAULT_MCP_HOST).strip()
    if not host:
        raise ValueError("DIMOS_DOG_MCP_HOST must be a non-empty host or address")

    raw_port = source.get("DIMOS_DOG_MCP_PORT", str(DEFAULT_MCP_PORT)).strip()
    try:
        port = int(raw_port)
    except ValueError as error:
        raise ValueError("DIMOS_DOG_MCP_PORT must be an integer from 1 to 65535") from error
    if not 1 <= port <= 65535:
        raise ValueError("DIMOS_DOG_MCP_PORT must be an integer from 1 to 65535")

    return McpServerConfig(host=host, port=port)
