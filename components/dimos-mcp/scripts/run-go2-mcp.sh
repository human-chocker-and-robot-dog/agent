#!/usr/bin/env bash
# Start the local real-Go2 MCP from a WSL-only private environment file.

set -Eeuo pipefail

readonly ENV_FILE="${DIMOS_DOG_MCP_ENV_FILE:-"$HOME/.config/dimos-dog-mcp/go2.env"}"
readonly MCP_LAUNCHER="${DIMOS_DOG_MCP_LAUNCHER:-"$HOME/dimensional-applications/.venv/bin/dimos-dog-mcp"}"

fail() {
    printf '错误：%s\n' "$*" >&2
    exit 1
}

[[ -f "$ENV_FILE" ]] || fail "找不到私有配置文件：$ENV_FILE"
[[ -r "$ENV_FILE" ]] || fail "无法读取私有配置文件：$ENV_FILE"

permissions="$(stat --format='%a' "$ENV_FILE")"
[[ "$permissions" == "600" ]] || fail "私有配置文件权限必须为 600，当前为 $permissions"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

[[ -n "${ROBOT_IP:-}" ]] || fail "go2.env 缺少 ROBOT_IP"
[[ -n "${UNITREE_AES_128_KEY:-}" ]] || fail "go2.env 缺少 UNITREE_AES_128_KEY"

export DIMOS_DOG_MCP_MODE="${DIMOS_DOG_MCP_MODE:-go2}"
[[ "$DIMOS_DOG_MCP_MODE" == "go2" ]] || fail "启动脚本仅允许 DIMOS_DOG_MCP_MODE=go2"

export DIMOS_DOG_MCP_HOST="${DIMOS_DOG_MCP_HOST:-127.0.0.1}"
export DIMOS_DOG_MCP_PORT="${DIMOS_DOG_MCP_PORT:-9990}"
export VIEWER="${VIEWER:-none}"

[[ -x "$MCP_LAUNCHER" ]] || fail "找不到 WSL 虚拟环境中的 dimos-dog-mcp：$MCP_LAUNCHER"

printf '启动真实 Go2 MCP：%s:%s/mcp\n' "$DIMOS_DOG_MCP_HOST" "$DIMOS_DOG_MCP_PORT"
exec "$MCP_LAUNCHER"
