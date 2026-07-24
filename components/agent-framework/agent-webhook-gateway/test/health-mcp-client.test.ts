import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	HealthMcpClient,
	type HealthMcpJsonRpcTransport,
	type JsonObject,
	StdioHealthMcpTransport,
} from "../src/index.ts";

describe("Health MCP stdio client contract", () => {
	it("initializes once and requires TextContent to equal structuredContent", async () => {
		const requests: Array<{ method: string; params: JsonObject }> = [];
		const notifications: Array<{ method: string; params: JsonObject }> = [];
		const envelope = {
			ok: true,
			data: { device: { status: "ok" } },
			meta: {
				schema_version: "0.2.0",
				generated_at: "2026-07-23T02:10:00.250Z",
				data_source: "live",
				age_ms: 35,
				trace_id: "7a916c4a-3b3e-4ec5-8491-e5fc7e843863",
			},
			error: null,
		};
		const transport: HealthMcpJsonRpcTransport = {
			request: async (method, params) => {
				requests.push({ method, params });
				if (method === "initialize") {
					return {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "smart-neckband-health", version: "0.2.0" },
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(envelope) }],
					structuredContent: envelope,
					isError: false,
				};
			},
			notify: async (method, params) => {
				notifications.push({ method, params });
			},
			close: async () => {},
		};
		const client = new HealthMcpClient(transport);

		await expect(
			Promise.all([
				client.callTool("health.get_device_status", { wearer_id: "xwen" }),
				client.callTool("health.get_device_status", { wearer_id: "xwen" }),
			]),
		).resolves.toEqual([
			{ isError: false, structuredContent: envelope },
			{ isError: false, structuredContent: envelope },
		]);

		expect(requests.map((request) => request.method)).toEqual(["initialize", "tools/call", "tools/call"]);
		expect(requests[0]?.params).toEqual({
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "pi-health-consumer", version: "0.2.0" },
		});
		expect(notifications).toEqual([{ method: "notifications/initialized", params: {} }]);
	});

	it("rejects a result whose compatibility TextContent disagrees with structuredContent", async () => {
		const transport: HealthMcpJsonRpcTransport = {
			request: async (method) => {
				if (method === "initialize") {
					return {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "smart-neckband-health", version: "0.2.0" },
					};
				}
				return {
					content: [{ type: "text", text: '{"ok":false}' }],
					structuredContent: { ok: true },
					isError: false,
				};
			},
			notify: async () => {},
			close: async () => {},
		};

		await expect(
			new HealthMcpClient(transport).callTool("health.get_device_status", { wearer_id: "xwen" }),
		).rejects.toThrow("TextContent does not equal structuredContent");
	});

	it("initializes a restarted transport session before the next tool call", async () => {
		const requests: string[] = [];
		const envelope = { ok: true, data: {}, meta: {}, error: null };
		const transport: HealthMcpJsonRpcTransport & { sessionGeneration: number } = {
			sessionGeneration: 0,
			request: async (method) => {
				requests.push(method);
				if (method === "initialize") {
					return {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "smart-neckband-health", version: "0.2.0" },
					};
				}
				return {
					content: [{ type: "text", text: JSON.stringify(envelope) }],
					structuredContent: envelope,
					isError: false,
				};
			},
			notify: async () => {},
			close: async () => {},
		};
		const client = new HealthMcpClient(transport);

		await client.callTool("health.get_device_status", { wearer_id: "xwen" });
		transport.sessionGeneration += 1;
		await client.callTool("health.get_device_status", { wearer_id: "xwen" });

		expect(requests).toEqual(["initialize", "tools/call", "initialize", "tools/call"]);
	});

	it("exchanges newline-delimited JSON-RPC with a stdio child process", async () => {
		const fixturePath = fileURLToPath(new URL("./support/fake-health-mcp.mjs", import.meta.url));
		const client = new HealthMcpClient(new StdioHealthMcpTransport(process.execPath, [fixturePath], 1_000));

		await expect(client.callTool("health.get_device_status", { wearer_id: "xwen" })).resolves.toMatchObject({
			isError: false,
			structuredContent: {
				ok: true,
				data: { echoed_tool: "health.get_device_status" },
			},
		});

		await client.close();
	});
});
