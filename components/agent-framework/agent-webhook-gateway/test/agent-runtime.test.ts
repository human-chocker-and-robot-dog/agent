import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt, createDogTools, createPiAgentSession } from "../src/agent-runtime.ts";

describe("fixed Pi agent runtime", () => {
	it("always tells the model that its final answer is delivered directly to the user", () => {
		const prompt = buildAgentSystemPrompt(0.1);

		expect(prompt).toContain("你的最终输出会直接发给用户");
		expect(prompt).toContain("距离 ÷ 时长");
		expect(prompt).toContain("0.1 米每秒");
		expect(prompt).toContain("方向默认为向前");
	});

	it("registers supported pinned official and custom wrapper MCP tools", () => {
		const tools = createDogTools({
			callTool: async () => "accepted",
		});

		expect(tools.map((tool) => tool.name)).toEqual([
			"move_forward",
			"move_backward",
			"stop_all",
			"motion_status",
			"server_status",
			"list_modules",
			"agent_send",
			"relative_move",
			"wait",
			"current_time",
			"execute_sport_command",
			"get_battery_soc",
			"observe",
			"tag_location",
			"navigate_with_text",
			"return_to_start",
			"begin_exploration",
			"start_patrol",
			"look_out_for",
			"start_stroll",
		]);
	});

	it("keeps all custom MCP tools active while disabling built-in coding tools", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-webhook-runtime-"));
		try {
			const session = await createPiAgentSession({
				cwd: directory,
				agentDir: join(directory, "agent"),
				sessionDir: join(directory, "session"),
				defaultSpeedMps: 0.1,
				mcp: { callTool: async () => "accepted" },
			});

			expect(session.getActiveToolNames()).toEqual([
				"move_forward",
				"move_backward",
				"stop_all",
				"motion_status",
				"server_status",
				"list_modules",
				"agent_send",
				"relative_move",
				"wait",
				"current_time",
				"execute_sport_command",
				"get_battery_soc",
				"observe",
				"tag_location",
				"navigate_with_text",
				"return_to_start",
				"begin_exploration",
				"start_patrol",
				"look_out_for",
				"start_stroll",
			]);
			session.dispose();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
