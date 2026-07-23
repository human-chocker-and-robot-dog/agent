#!/usr/bin/env node
import { PiUserTextAgent } from "./agent-runtime.ts";
import { readGatewayConfig } from "./config.ts";
import { createInstructionServer } from "./http-server.ts";
import { HttpMcpToolClient } from "./mcp-client.ts";
import { ReplyWebhookClient } from "./reply-client.ts";
import { AgentWebhookService } from "./service.ts";
import { GatewayStore } from "./store.ts";

async function main(): Promise<void> {
	const config = readGatewayConfig();
	const mcp = new HttpMcpToolClient(config.mcpWrapperUrl, config.mcpTimeoutMs);
	const agent = await PiUserTextAgent.create({
		cwd: config.agentCwd,
		agentDir: config.agentDir,
		sessionDir: config.sessionDir,
		defaultSpeedMps: config.defaultSpeedMps,
		mcp,
	});
	const service = new AgentWebhookService({
		store: new GatewayStore(config.databasePath),
		agent,
		mcp,
		replyClient: new ReplyWebhookClient(config.replyWebhookUrl, config.replyTimeoutMs),
		retryBaseMs: config.retryBaseMs,
		retryMaxMs: config.retryMaxMs,
	});
	service.start();
	const server = createInstructionServer(service);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.host, resolve);
	});
	console.log(`agent webhook gateway listening on http://${config.host}:${config.port}/v1/instructions`);

	let shutdownPromise: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		if (shutdownPromise) {
			return shutdownPromise;
		}
		shutdownPromise = (async () => {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			await service.close();
		})();
		return shutdownPromise;
	};
	process.once("SIGINT", () => {
		void shutdown().then(() => {
			process.exitCode = 0;
		});
	});
	process.once("SIGTERM", () => {
		void shutdown().then(() => {
			process.exitCode = 0;
		});
	});
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
