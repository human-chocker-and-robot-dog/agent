import { describe, expect, it } from "vitest";
import { runDryRunDemo } from "./support/dry-run-demo.ts";

describe("local dry-run end-to-end demo", () => {
	it("delivers normal and stop replies through single MCP forwarding calls", async () => {
		const summary = await runDryRunDemo();

		expect(summary).toEqual({
			agentRuns: 1,
			callbackInstructionIds: ["dry-run-stop", "dry-run-move"],
			wrapperToolCalls: ["move_forward", "stop_motion"],
			dogToolCalls: ["move_forward", "stop_motion"],
		});
	});
});
