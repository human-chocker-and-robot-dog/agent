import type { AgentReplyEvent, ReplyEventDelivery } from "./types.ts";

export class ReplyWebhookClient implements ReplyEventDelivery {
	private readonly callbackUrl: string;
	private readonly timeoutMs: number;

	constructor(callbackUrl: string, timeoutMs: number) {
		this.callbackUrl = callbackUrl;
		this.timeoutMs = timeoutMs;
	}

	async deliver(event: AgentReplyEvent): Promise<void> {
		const response = await fetch(this.callbackUrl, {
			method: "POST",
			headers: { "content-type": "application/json; charset=utf-8" },
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Reply webhook returned HTTP ${response.status}`);
		}
		await response.body?.cancel();
	}
}
