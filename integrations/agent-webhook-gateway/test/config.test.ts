import { describe, expect, it } from "vitest";
import { readGatewayConfig } from "../src/config.ts";

describe("gateway configuration", () => {
	it("requires one deployment-level reply URL and keeps the documented local defaults", () => {
		const config = readGatewayConfig(
			{ AGENT_WEBHOOK_REPLY_URL: "http://127.0.0.1:9080/replies" },
			"C:/gateway",
			"C:/Users/operator",
		);

		expect(config).toMatchObject({
			host: "127.0.0.1",
			port: 8080,
			replyWebhookUrl: "http://127.0.0.1:9080/replies",
			mcpWrapperUrl: "http://127.0.0.1:9991/mcp",
			defaultSpeedMps: 0.1,
		});
		expect(config.databasePath.replaceAll("\\", "/")).toBe("C:/gateway/data/agent-webhook.sqlite");
		expect(config.agentDir.replaceAll("\\", "/")).toBe("C:/Users/operator/.pi/agent");
	});

	it("rejects startup without a valid reply URL", () => {
		expect(() => readGatewayConfig({}, "C:/gateway", "C:/Users/operator")).toThrow(
			"AGENT_WEBHOOK_REPLY_URL is required",
		);
		expect(() =>
			readGatewayConfig({ AGENT_WEBHOOK_REPLY_URL: "not-a-url" }, "C:/gateway", "C:/Users/operator"),
		).toThrow("AGENT_WEBHOOK_REPLY_URL must be an absolute HTTP(S) URL");
	});
});
