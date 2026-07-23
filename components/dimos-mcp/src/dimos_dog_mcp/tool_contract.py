"""Public MCP tool contract for the pinned DiMOS release and local extensions."""

from __future__ import annotations


OFFICIAL_MCP_SERVER_TOOL_NAMES = frozenset(
    {
        "server_status",
        "list_modules",
        "agent_send",
    }
)

OFFICIAL_ROBOT_TOOL_NAMES = frozenset(
    {
        "relative_move",
        "wait",
        "current_time",
        "execute_sport_command",
        "get_battery_soc",
        "observe",
        "tag_location",
        "navigate_with_text",
        "stop_navigation",
        "begin_exploration",
        "end_exploration",
        "start_patrol",
        "stop_patrol",
        "look_out_for",
        "stop_looking_out",
    }
)

CUSTOM_TOOL_NAMES = frozenset(
    {
        "move_forward",
        "move_backward",
        "stop_motion",
        "motion_status",
        "return_to_start",
        "start_stroll",
        "stop_stroll",
    }
)

PUBLIC_TOOL_NAMES = OFFICIAL_MCP_SERVER_TOOL_NAMES | OFFICIAL_ROBOT_TOOL_NAMES | CUSTOM_TOOL_NAMES
