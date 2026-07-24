import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentWebhookService,
	createInstructionServer,
	GatewayStore,
	type HealthMcpToolCaller,
	HealthNotificationService,
	HealthWebhookReceiver,
} from "../src/index.ts";

const WEBHOOK_SECRET_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const WEBHOOK_TIMESTAMP = "1784772600";
const WEBHOOK_SIGNATURE = "v1=217d52203ca73e60f36a9f6c323e34023e22a00d3db74af92522ae6d5c974067";
const WEBHOOK_BODY =
	'{"schema_version":"0.2.0","notification_id":"894d7ebf-3c7a-4818-a85d-3555a0d4dd13","notification_sequence":431,"event_id":"50d40557-8df6-47b5-abce-1ef447bf5543","event_revision":2,"transition":"resolved","event_type":"lead_off","wearer_id":"xwen","source_instance_id":"ef132c67-a98f-474a-a673-4ab6ea784790","state_revision":1849,"data_source":"live","occurred_at":"2026-07-23T02:10:03.000Z","sent_at":"2026-07-23T02:10:03.120Z","trace_id":"7a916c4a-3b3e-4ec5-8491-e5fc7e843863","test_mode":false}';

const servers: Server[] = [];
const directories: string[] = [];
const healthServices: HealthNotificationService[] = [];
const instructionServices: AgentWebhookService[] = [];

afterEach(async () => {
	await Promise.all(healthServices.splice(0).map((service) => service.close()));
	await Promise.all(instructionServices.splice(0).map((service) => service.close()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				}),
		),
	);
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected an IPv4 test server address");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for health notification processing");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("smart-collar health webhook", () => {
	it("persists and ACKs before independently verifying authoritative MCP state without physical action", async () => {
		const directory = mkdtempSync(join(tmpdir(), "health-webhook-"));
		directories.push(directory);
		const store = new GatewayStore(join(directory, "gateway.sqlite"));
		const mcpCalls: Array<{ name: string; arguments: Readonly<Record<string, unknown>> }> = [];
		const outcomes: string[] = [];
		let stateAttempts = 0;
		const healthMcp: HealthMcpToolCaller = {
			callTool: async (name, arguments_) => {
				mcpCalls.push({ name, arguments: arguments_ });
				if (name === "health.get_event_details") {
					return {
						isError: false,
						structuredContent: {
							ok: true,
							data: {
								event: {
									schema_version: "0.2.0",
									event_id: "50d40557-8df6-47b5-abce-1ef447bf5543",
									event_revision: 2,
									event_type: "lead_off",
									wearer_id: "xwen",
									source_instance_id: "ef132c67-a98f-474a-a673-4ab6ea784790",
									data_source: "live",
									status: "resolved",
									test_mode: false,
								},
							},
							meta: {},
							error: null,
						},
					};
				}
				stateAttempts += 1;
				if (stateAttempts === 1) {
					return {
						isError: true,
						structuredContent: {
							ok: false,
							data: null,
							meta: {},
							error: {
								code: "STATE_STALE",
								message: "Latest wearer state is older than max_age_ms.",
								retryable: true,
								retry_after_ms: 1,
								details: {},
							},
						},
					};
				}
				return {
					isError: false,
					structuredContent: {
						ok: true,
						data: {
							state: {
								schema_version: "0.2.0",
								wearer_id: "xwen",
								state_revision: 1850,
								source_instance_id: "ef132c67-a98f-474a-a673-4ab6ea784790",
								data_source: "live",
								freshness: "fresh",
								test_mode: false,
							},
						},
						meta: {},
						error: null,
					},
				};
			},
		};
		const healthService = new HealthNotificationService({
			store,
			mcp: healthMcp,
			wearerId: "xwen",
			retryBaseMs: 1,
			retryMaxMs: 1,
			onOutcome: (outcome) => outcomes.push(outcome),
		});
		healthServices.push(healthService);
		healthService.start();
		const instructionService = new AgentWebhookService({
			store,
			agent: { run: async () => "unused" },
			mcp: { callTool: async () => "unused" },
			replyClient: { deliver: async () => {} },
		});
		instructionServices.push(instructionService);
		instructionService.start();
		const healthReceiver = new HealthWebhookReceiver({
			store,
			healthService,
			keys: new Map([["health-webhook-2026-07", Buffer.from(WEBHOOK_SECRET_HEX, "hex")]]),
			nowEpochSeconds: () => Number(WEBHOOK_TIMESTAMP),
		});
		const gatewayUrl = await listen(createInstructionServer(instructionService, healthReceiver));

		const send = () =>
			fetch(`${gatewayUrl}/v1/health-events`, {
				method: "POST",
				headers: {
					"content-type": "application/json; charset=utf-8",
					"x-smart-collar-key-id": "health-webhook-2026-07",
					"x-smart-collar-timestamp": WEBHOOK_TIMESTAMP,
					"x-smart-collar-notification-id": "894d7ebf-3c7a-4818-a85d-3555a0d4dd13",
					"x-smart-collar-signature": WEBHOOK_SIGNATURE,
				},
				body: WEBHOOK_BODY,
			});

		const accepted = await send();
		expect(accepted.status).toBe(202);
		expect(await accepted.json()).toEqual({
			notification_id: "894d7ebf-3c7a-4818-a85d-3555a0d4dd13",
			status: "accepted",
		});
		await waitFor(() => outcomes.length === 1);
		expect(outcomes).toEqual(["verified_no_action"]);
		expect(mcpCalls).toEqual([
			{
				name: "health.get_event_details",
				arguments: { event_id: "50d40557-8df6-47b5-abce-1ef447bf5543" },
			},
			{
				name: "health.get_current_state",
				arguments: { wearer_id: "xwen", max_age_ms: 2000 },
			},
			{
				name: "health.get_event_details",
				arguments: { event_id: "50d40557-8df6-47b5-abce-1ef447bf5543" },
			},
			{
				name: "health.get_current_state",
				arguments: { wearer_id: "xwen", max_age_ms: 2000 },
			},
		]);

		const duplicate = await send();
		expect(duplicate.status).toBe(202);
		expect(await duplicate.json()).toEqual({
			notification_id: "894d7ebf-3c7a-4818-a85d-3555a0d4dd13",
			status: "duplicate",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(mcpCalls).toHaveLength(4);
	});

	it("applies the contract validation order and exact HTTP error mapping", async () => {
		const directory = mkdtempSync(join(tmpdir(), "health-webhook-errors-"));
		directories.push(directory);
		const store = new GatewayStore(join(directory, "gateway.sqlite"));
		const healthService = new HealthNotificationService({
			store,
			mcp: {
				callTool: async () => {
					throw new Error("MCP must not be called for rejected HTTP requests");
				},
			},
			wearerId: "xwen",
		});
		healthServices.push(healthService);
		healthService.start();
		const instructionService = new AgentWebhookService({
			store,
			agent: { run: async () => "unused" },
			mcp: { callTool: async () => "unused" },
			replyClient: { deliver: async () => {} },
		});
		instructionServices.push(instructionService);
		instructionService.start();
		const receiver = new HealthWebhookReceiver({
			store,
			healthService,
			keys: new Map([["health-webhook-2026-07", Buffer.from(WEBHOOK_SECRET_HEX, "hex")]]),
			nowEpochSeconds: () => Number(WEBHOOK_TIMESTAMP),
		});
		const gatewayUrl = await listen(createInstructionServer(instructionService, receiver));

		const wrongMethod = await fetch(`${gatewayUrl}/v1/health-events`);
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get("allow")).toBe("POST");
		expect(await wrongMethod.json()).toEqual({ error: "method_not_allowed" });

		const wrongContentType = await fetch(`${gatewayUrl}/v1/health-events`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: WEBHOOK_BODY,
		});
		expect(wrongContentType.status).toBe(415);
		expect(await wrongContentType.json()).toEqual({ error: "unsupported_media_type" });

		const malformedTimestamp = await fetch(`${gatewayUrl}/v1/health-events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-smart-collar-key-id": "unknown",
				"x-smart-collar-timestamp": `0${WEBHOOK_TIMESTAMP}`,
				"x-smart-collar-notification-id": "894d7ebf-3c7a-4818-a85d-3555a0d4dd13",
				"x-smart-collar-signature": "v1=invalid",
			},
			body: WEBHOOK_BODY,
		});
		expect(malformedTimestamp.status).toBe(401);
		expect(await malformedTimestamp.json()).toEqual({ error: "timestamp_out_of_range" });

		const invalidSignature = await fetch(`${gatewayUrl}/v1/health-events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-smart-collar-key-id": "health-webhook-2026-07",
				"x-smart-collar-timestamp": WEBHOOK_TIMESTAMP,
				"x-smart-collar-notification-id": "894d7ebf-3c7a-4818-a85d-3555a0d4dd13",
				"x-smart-collar-signature": `v1=${"0".repeat(64)}`,
			},
			body: WEBHOOK_BODY,
		});
		expect(invalidSignature.status).toBe(401);
		expect(await invalidSignature.json()).toEqual({ error: "invalid_signature" });

		const mismatchedNotificationId = await fetch(`${gatewayUrl}/v1/health-events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-smart-collar-key-id": "health-webhook-2026-07",
				"x-smart-collar-timestamp": WEBHOOK_TIMESTAMP,
				"x-smart-collar-notification-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				"x-smart-collar-signature": WEBHOOK_SIGNATURE,
			},
			body: WEBHOOK_BODY,
		});
		expect(mismatchedNotificationId.status).toBe(400);
		expect(await mismatchedNotificationId.json()).toEqual({ error: "invalid_request" });
	});

	it("atomically accepts one concurrent delivery and detects raw-body conflicts", async () => {
		const directory = mkdtempSync(join(tmpdir(), "health-webhook-idempotency-"));
		directories.push(directory);
		const store = new GatewayStore(join(directory, "gateway.sqlite"));
		const healthService = new HealthNotificationService({
			store,
			mcp: {
				callTool: async () => {
					throw new Error("health MCP unavailable in idempotency test");
				},
			},
			wearerId: "xwen",
			retryBaseMs: 60_000,
			retryMaxMs: 60_000,
		});
		healthServices.push(healthService);
		healthService.start();
		const instructionService = new AgentWebhookService({
			store,
			agent: { run: async () => "unused" },
			mcp: { callTool: async () => "unused" },
			replyClient: { deliver: async () => {} },
		});
		instructionServices.push(instructionService);
		instructionService.start();
		const receiver = new HealthWebhookReceiver({
			store,
			healthService,
			keys: new Map([["health-webhook-2026-07", Buffer.from(WEBHOOK_SECRET_HEX, "hex")]]),
			nowEpochSeconds: () => Number(WEBHOOK_TIMESTAMP),
		});
		const gatewayUrl = await listen(createInstructionServer(instructionService, receiver));
		const send = (body: string, signature: string) =>
			fetch(`${gatewayUrl}/v1/health-events`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-smart-collar-key-id": "health-webhook-2026-07",
					"x-smart-collar-timestamp": WEBHOOK_TIMESTAMP,
					"x-smart-collar-notification-id": "894d7ebf-3c7a-4818-a85d-3555a0d4dd13",
					"x-smart-collar-signature": signature,
				},
				body,
			});

		const concurrent = await Promise.all(Array.from({ length: 5 }, () => send(WEBHOOK_BODY, WEBHOOK_SIGNATURE)));
		const statuses = await Promise.all(concurrent.map((response) => response.json() as Promise<{ status: string }>));
		expect(statuses.filter((body) => body.status === "accepted")).toHaveLength(1);
		expect(statuses.filter((body) => body.status === "duplicate")).toHaveLength(4);

		const conflictingBody = WEBHOOK_BODY.replace(
			'"sent_at":"2026-07-23T02:10:03.120Z"',
			'"sent_at":"2026-07-23T02:10:03.121Z"',
		);
		const conflictingSignature = `v1=${createHmac("sha256", Buffer.from(WEBHOOK_SECRET_HEX, "hex"))
			.update(`${WEBHOOK_TIMESTAMP}.${conflictingBody}`)
			.digest("hex")}`;
		const conflict = await send(conflictingBody, conflictingSignature);
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ error: "notification_id_conflict" });
	});
});
