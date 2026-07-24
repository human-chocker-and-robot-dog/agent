import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInstructionServer } from "../../src/http-server.ts";
import { HttpMcpToolClient } from "../../src/mcp-client.ts";
import { ReplyWebhookClient } from "../../src/reply-client.ts";
import { AgentWebhookService } from "../../src/service.ts";
import { GatewayStore } from "../../src/store.ts";
import type { AgentReplyEvent, UserTextAgent } from "../../src/types.ts";

const MOVE_INSTRUCTION_ID = "dry-run-move";
const MOVE_INSTRUCTION_TEXT = "以 0.1 米每秒向前移动 0.01 秒";
const MOVE_REPLY_TEXT = "dry-run 指令已被 MCP 接受。";
const STOP_INSTRUCTION_ID = "dry-run-stop";
const STOP_REPLY_TEXT = "已发送停止指令。";

interface McpCall {
	name: string;
	arguments: Record<string, unknown>;
}

export interface DryRunDemoSummary {
	agentRuns: number;
	callbackInstructionIds: string[];
	wrapperToolCalls: string[];
	dogToolCalls: string[];
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: () => {
			resolvePromise?.();
		},
	};
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	let body = "";
	request.setEncoding("utf8");
	for await (const chunk of request) {
		body += String(chunk);
	}
	return JSON.parse(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

function parseMcpCall(value: unknown): { id: unknown; call: McpCall } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("MCP request must be a JSON object");
	}
	const request = value as Record<string, unknown>;
	if (request.jsonrpc !== "2.0" || request.method !== "tools/call") {
		throw new Error("Expected one JSON-RPC tools/call request");
	}
	if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
		throw new Error("MCP request params must be an object");
	}
	const params = request.params as Record<string, unknown>;
	if (typeof params.name !== "string") {
		throw new Error("MCP tool name must be a string");
	}
	if (!params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments)) {
		throw new Error("MCP tool arguments must be an object");
	}
	return {
		id: request.id,
		call: {
			name: params.name,
			arguments: { ...(params.arguments as Record<string, unknown>) },
		},
	};
}

function parseReplyEvent(value: unknown): AgentReplyEvent {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Reply callback must be a JSON object");
	}
	const event = value as Record<string, unknown>;
	if (
		event.event !== "agent.reply.completed" ||
		typeof event.reply_id !== "string" ||
		typeof event.instruction_id !== "string" ||
		typeof event.text !== "string" ||
		typeof event.completed_at !== "string"
	) {
		throw new Error("Reply callback does not match agent.reply.completed");
	}
	return {
		event: "agent.reply.completed",
		reply_id: event.reply_id,
		instruction_id: event.instruction_id,
		text: event.text,
		completed_at: event.completed_at,
	};
}

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected an IPv4 server address");
	}
	return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	await new Promise<void>((resolveClose, reject) => {
		server.close((error) => (error ? reject(error) : resolveClose()));
	});
}

async function waitFor<T>(readValue: () => T | undefined): Promise<T> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const value = readValue();
		if (value !== undefined) {
			return value;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	throw new Error("Timed out waiting for dry-run end-to-end work");
}

async function submitInstruction(gatewayUrl: string, instructionId: string, text: string): Promise<void> {
	const response = await fetch(`${gatewayUrl}/v1/instructions`, {
		method: "POST",
		headers: { "content-type": "application/json; charset=utf-8" },
		body: JSON.stringify({ instruction_id: instructionId, text }),
	});
	equal(response.status, 202);
	deepStrictEqual(await response.json(), {
		instruction_id: instructionId,
		status: "accepted",
	});
}

function createDogMcpSubstitute(calls: McpCall[]): Server {
	return createServer(async (request, response) => {
		try {
			equal(request.method, "POST");
			equal(request.url, "/mcp");
			const { id, call } = parseMcpCall(await readJson(request));
			calls.push(call);
			sendJson(response, 200, {
				jsonrpc: "2.0",
				id,
				result: {
					content: [
						{
							type: "text",
							text: JSON.stringify({ status: "ok", mode: "dry-run", tool: call.name }),
						},
					],
				},
			});
		} catch (error) {
			sendJson(response, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

function createWrapperSubstitute(upstreamUrl: string, calls: McpCall[]): Server {
	return createServer(async (request, response) => {
		try {
			equal(request.method, "POST");
			equal(request.url, "/mcp");
			const body = await readJson(request);
			calls.push(parseMcpCall(body).call);
			const upstreamResponse = await fetch(`${upstreamUrl}/mcp`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
			const responseBody = await upstreamResponse.text();
			response.writeHead(upstreamResponse.status, {
				"content-type": upstreamResponse.headers.get("content-type") ?? "application/json",
			});
			response.end(responseBody);
		} catch (error) {
			sendJson(response, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

function createReplyReceiver(replies: AgentReplyEvent[]): Server {
	return createServer(async (request, response) => {
		try {
			equal(request.method, "POST");
			equal(request.url, "/agent-replies");
			replies.push(parseReplyEvent(await readJson(request)));
			response.writeHead(204).end();
		} catch (error) {
			sendJson(response, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

export async function runDryRunDemo(): Promise<DryRunDemoSummary> {
	const directory = mkdtempSync(join(tmpdir(), "pi-dry-run-e2e-"));
	const servers: Server[] = [];
	const wrapperCalls: McpCall[] = [];
	const dogCalls: McpCall[] = [];
	const replies: AgentReplyEvent[] = [];
	const moveReachedDog = deferred();
	const releaseAgent = deferred();
	let service: AgentWebhookService | undefined;
	let agentRuns = 0;

	try {
		const dogServer = createDogMcpSubstitute(dogCalls);
		servers.push(dogServer);
		const dogUrl = await listen(dogServer);

		const wrapperServer = createWrapperSubstitute(dogUrl, wrapperCalls);
		servers.push(wrapperServer);
		const wrapperUrl = await listen(wrapperServer);

		const replyServer = createReplyReceiver(replies);
		servers.push(replyServer);
		const replyUrl = await listen(replyServer);

		const mcp = new HttpMcpToolClient(`${wrapperUrl}/mcp`, 1_000);
		const agent: UserTextAgent = {
			run: async (text) => {
				agentRuns++;
				equal(text, MOVE_INSTRUCTION_TEXT);
				await mcp.callTool("move_forward", { speed_mps: 0.1, duration_s: 0.01 });
				moveReachedDog.resolve();
				await releaseAgent.promise;
				return MOVE_REPLY_TEXT;
			},
		};
		service = new AgentWebhookService({
			store: new GatewayStore(join(directory, "gateway.sqlite")),
			agent,
			mcp,
			replyClient: new ReplyWebhookClient(`${replyUrl}/agent-replies`, 1_000),
			retryBaseMs: 10,
			retryMaxMs: 10,
		});
		service.start();

		const gatewayServer = createInstructionServer(service);
		servers.push(gatewayServer);
		const gatewayUrl = await listen(gatewayServer);

		await submitInstruction(gatewayUrl, MOVE_INSTRUCTION_ID, MOVE_INSTRUCTION_TEXT);
		await moveReachedDog.promise;
		await submitInstruction(gatewayUrl, STOP_INSTRUCTION_ID, " STOP！ ");

		const stopReply = await waitFor(() => replies.find((reply) => reply.instruction_id === STOP_INSTRUCTION_ID));
		equal(agentRuns, 1);
		equal(stopReply.text, STOP_REPLY_TEXT);
		deepStrictEqual(
			wrapperCalls.map((call) => call.name),
			["move_forward", "stop_all"],
		);
		deepStrictEqual(
			dogCalls.map((call) => call.name),
			["move_forward", "stop_all"],
		);
		deepStrictEqual(wrapperCalls, dogCalls);
		deepStrictEqual(wrapperCalls[0]?.arguments, { speed_mps: 0.1, duration_s: 0.01 });
		deepStrictEqual(wrapperCalls[1]?.arguments, {});

		releaseAgent.resolve();
		const moveReply = await waitFor(() => replies.find((reply) => reply.instruction_id === MOVE_INSTRUCTION_ID));
		equal(moveReply.text, MOVE_REPLY_TEXT);
		equal(replies.length, 2);
		for (const reply of replies) {
			equal(reply.event, "agent.reply.completed");
			ok(reply.reply_id);
			match(reply.completed_at, /Z$/);
		}

		return {
			agentRuns,
			callbackInstructionIds: replies.map((reply) => reply.instruction_id),
			wrapperToolCalls: wrapperCalls.map((call) => call.name),
			dogToolCalls: dogCalls.map((call) => call.name),
		};
	} finally {
		releaseAgent.resolve();
		await service?.close();
		await Promise.all(servers.map(closeServer));
		rmSync(directory, { recursive: true, force: true });
	}
}

const isDirectRun = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
	runDryRunDemo()
		.then((summary) => {
			console.log("dry-run e2e passed");
			console.log(JSON.stringify(summary, null, 2));
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.stack : String(error));
			process.exitCode = 1;
		});
}
