import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import {
	type HealthMcpToolCaller,
	type HealthMcpToolResult,
	isJsonObject,
	type JsonObject,
} from "./health-contract.ts";

const MCP_PROTOCOL_VERSION = "2025-11-25";

export class HealthMcpProtocolError extends Error {}

export interface HealthMcpJsonRpcTransport {
	readonly sessionGeneration?: number;
	request(method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject>;
	notify(method: string, params: JsonObject): Promise<void>;
	close(): Promise<void>;
}

export class HealthMcpClient implements HealthMcpToolCaller {
	private readonly transport: HealthMcpJsonRpcTransport;
	private initializePromise?: Promise<void>;
	private initializingGeneration?: number;
	private initializedGeneration?: number;

	constructor(transport: HealthMcpJsonRpcTransport) {
		this.transport = transport;
	}

	async callTool(
		name: string,
		arguments_: Readonly<Record<string, unknown>>,
		signal?: AbortSignal,
	): Promise<HealthMcpToolResult> {
		await this.initialize();
		const result = await this.transport.request(
			"tools/call",
			{
				name,
				arguments: { ...arguments_ },
			},
			signal,
		);
		const structuredContent = result.structuredContent;
		const content = result.content;
		if (!isJsonObject(structuredContent) || typeof result.isError !== "boolean") {
			throw new HealthMcpProtocolError("Health MCP tools/call result is missing structuredContent or isError");
		}
		if (!Array.isArray(content) || content.length !== 1) {
			throw new HealthMcpProtocolError("Health MCP tools/call result must contain exactly one TextContent");
		}
		const textContent = content[0];
		if (!isJsonObject(textContent) || textContent.type !== "text" || typeof textContent.text !== "string") {
			throw new HealthMcpProtocolError("Health MCP tools/call result contains invalid TextContent");
		}
		let textEnvelope: unknown;
		try {
			textEnvelope = JSON.parse(textContent.text);
		} catch {
			throw new HealthMcpProtocolError("Health MCP TextContent is not valid JSON");
		}
		if (!isDeepStrictEqual(textEnvelope, structuredContent)) {
			throw new HealthMcpProtocolError("Health MCP TextContent does not equal structuredContent");
		}
		return {
			isError: result.isError,
			structuredContent,
		};
	}

	private initialize(): Promise<void> {
		const generation = this.transport.sessionGeneration;
		if (
			this.initializePromise &&
			(generation === undefined ||
				generation === this.initializingGeneration ||
				generation === this.initializedGeneration)
		) {
			return this.initializePromise;
		}
		this.initializingGeneration = generation;
		const tracked = this.initializeTransport().then(
			() => {
				if (this.initializePromise === tracked) {
					this.initializingGeneration = undefined;
				}
			},
			(error: unknown) => {
				if (this.initializePromise === tracked) {
					this.initializePromise = undefined;
					this.initializingGeneration = undefined;
					this.initializedGeneration = undefined;
				}
				throw error;
			},
		);
		this.initializePromise = tracked;
		return tracked;
	}

	private async initializeTransport(): Promise<void> {
		const result = await this.transport.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: {
				name: "pi-health-consumer",
				version: "0.2.0",
			},
		});
		const negotiatedGeneration = this.transport.sessionGeneration;
		if (
			result.protocolVersion !== MCP_PROTOCOL_VERSION ||
			!isJsonObject(result.capabilities) ||
			!isJsonObject(result.serverInfo)
		) {
			throw new HealthMcpProtocolError(`Health MCP server did not negotiate protocol ${MCP_PROTOCOL_VERSION}`);
		}
		await this.transport.notify("notifications/initialized", {});
		if (this.transport.sessionGeneration !== negotiatedGeneration) {
			throw new Error("Health MCP transport session changed during initialization");
		}
		this.initializedGeneration = negotiatedGeneration;
	}

	async close(): Promise<void> {
		await this.transport.close();
	}
}

interface PendingRequest {
	resolve: (value: JsonObject) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
	signal: AbortSignal | undefined;
	abortListener: (() => void) | undefined;
}

export class StdioHealthMcpTransport implements HealthMcpJsonRpcTransport {
	private readonly command: string;
	private readonly args: readonly string[];
	private readonly timeoutMs: number;
	private child?: ChildProcessWithoutNullStreams;
	private lines?: ReadlineInterface;
	private readonly pending = new Map<string, PendingRequest>();
	private nextRequestId = 1;
	private closed = false;
	private generation = 0;

	get sessionGeneration(): number {
		return this.generation;
	}

	constructor(command: string, args: readonly string[], timeoutMs: number) {
		this.command = command;
		this.args = args;
		this.timeoutMs = timeoutMs;
	}

	async request(method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
		const child = this.ensureStarted();
		const id = this.nextRequestId++;
		const key = String(id);
		return await new Promise<JsonObject>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.rejectPending(key, new Error(`Health MCP request timed out after ${this.timeoutMs} ms`));
			}, this.timeoutMs);
			timeout.unref();
			const abortListener = signal
				? () => this.rejectPending(key, new Error("Health MCP request was aborted"))
				: undefined;
			if (signal?.aborted) {
				clearTimeout(timeout);
				reject(new Error("Health MCP request was aborted"));
				return;
			}
			if (signal && abortListener) {
				signal.addEventListener("abort", abortListener, { once: true });
			}
			this.pending.set(key, { resolve, reject, timeout, signal, abortListener });
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, "utf8", (error) => {
				if (error) {
					this.rejectPending(key, error);
				}
			});
		});
	}

	async notify(method: string, params: JsonObject): Promise<void> {
		const child = this.ensureStarted();
		await new Promise<void>((resolve, reject) => {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8", (error) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	private ensureStarted(): ChildProcessWithoutNullStreams {
		if (this.closed) {
			throw new Error("Health MCP stdio transport is closed");
		}
		if (this.child) {
			return this.child;
		}
		const child = spawn(this.command, [...this.args], {
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		this.lines = createInterface({ input: child.stdout });
		this.lines.on("line", (line) => this.handleLine(line));
		child.once("error", (error) => {
			this.clearExitedChild(child);
			this.failAll(error);
		});
		child.once("exit", (code, signal) => {
			this.clearExitedChild(child);
			if (!this.closed) {
				this.failAll(new Error(`Health MCP process exited (code=${String(code)}, signal=${String(signal)})`));
			}
		});
		child.stderr.pipe(process.stderr, { end: false });
		return child;
	}

	private clearExitedChild(child: ChildProcessWithoutNullStreams): void {
		if (this.child !== child) {
			return;
		}
		this.lines?.close();
		this.lines = undefined;
		this.child = undefined;
		this.generation += 1;
	}

	private handleLine(line: string): void {
		let payload: unknown;
		try {
			payload = JSON.parse(line);
		} catch {
			this.failAll(new HealthMcpProtocolError("Health MCP wrote invalid JSON to stdout"));
			return;
		}
		if (!isJsonObject(payload) || (typeof payload.id !== "number" && typeof payload.id !== "string")) {
			return;
		}
		const key = String(payload.id);
		const pending = this.takePending(key);
		if (!pending) {
			return;
		}
		if (payload.jsonrpc !== "2.0") {
			pending.reject(new HealthMcpProtocolError("Health MCP JSON-RPC response has an invalid version"));
			return;
		}
		if (isJsonObject(payload.error)) {
			const code = typeof payload.error.code === "number" ? payload.error.code : "unknown";
			const message = typeof payload.error.message === "string" ? payload.error.message : "unknown JSON-RPC error";
			pending.reject(new HealthMcpProtocolError(`Health MCP JSON-RPC error ${code}: ${message}`));
			return;
		}
		if (!isJsonObject(payload.result)) {
			pending.reject(new HealthMcpProtocolError("Health MCP JSON-RPC response is missing result"));
			return;
		}
		pending.resolve(payload.result);
	}

	private rejectPending(key: string, error: Error): void {
		this.takePending(key)?.reject(error);
	}

	private takePending(key: string): PendingRequest | undefined {
		const pending = this.pending.get(key);
		if (!pending) {
			return undefined;
		}
		this.pending.delete(key);
		clearTimeout(pending.timeout);
		if (pending.signal && pending.abortListener) {
			pending.signal.removeEventListener("abort", pending.abortListener);
		}
		return pending;
	}

	private failAll(error: Error): void {
		for (const key of [...this.pending.keys()]) {
			this.rejectPending(key, error);
		}
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.lines?.close();
		this.failAll(new Error("Health MCP stdio transport closed"));
		const child = this.child;
		if (!child) {
			return;
		}
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) {
			child.kill();
		}
	}
}
