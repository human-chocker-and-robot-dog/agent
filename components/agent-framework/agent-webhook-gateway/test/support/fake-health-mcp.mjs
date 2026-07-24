import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.method === "initialize") {
		write({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "fake-health-mcp", version: "0.2.0" },
			},
		});
		return;
	}
	if (request.method === "tools/call") {
		const structuredContent = {
			ok: true,
			data: { echoed_tool: request.params.name },
			meta: {
				schema_version: "0.2.0",
				generated_at: "2026-07-23T02:10:00.250Z",
				data_source: "synthetic",
				age_ms: 0,
				trace_id: "7a916c4a-3b3e-4ec5-8491-e5fc7e843863",
			},
			error: null,
		};
		write({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				content: [{ type: "text", text: JSON.stringify(structuredContent) }],
				structuredContent,
				isError: false,
			},
		});
	}
});

function write(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}
