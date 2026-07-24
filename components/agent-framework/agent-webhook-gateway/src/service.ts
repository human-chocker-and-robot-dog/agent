import type { GatewayStore } from "./store.ts";
import {
	type ExternalInstruction,
	FAILURE_REPLY_TEXT,
	type McpToolCaller,
	type ReplyEventDelivery,
	STOP_ACCEPTED_REPLY_TEXT,
	type UserTextAgent,
} from "./types.ts";

export class InstructionConflictError extends Error {}

export interface AgentWebhookServiceOptions {
	store: GatewayStore;
	agent: UserTextAgent;
	mcp: McpToolCaller;
	replyClient: ReplyEventDelivery;
	retryBaseMs?: number;
	retryMaxMs?: number;
	onBackgroundError?: (error: unknown) => void;
}

export class AgentWebhookService {
	private readonly store: GatewayStore;
	private readonly agent: UserTextAgent;
	private readonly mcp: McpToolCaller;
	private readonly replyClient: ReplyEventDelivery;
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;
	private readonly onBackgroundError: (error: unknown) => void;
	private agentDrainPromise?: Promise<void>;
	private stopDrainPromise?: Promise<void>;
	private deliveryPromise?: Promise<void>;
	private retryTimer?: NodeJS.Timeout;
	private closed = false;

	constructor(options: AgentWebhookServiceOptions) {
		this.store = options.store;
		this.agent = options.agent;
		this.mcp = options.mcp;
		this.replyClient = options.replyClient;
		this.retryBaseMs = options.retryBaseMs ?? 1_000;
		this.retryMaxMs = options.retryMaxMs ?? 60_000;
		this.onBackgroundError = options.onBackgroundError ?? ((error) => console.error(error));
	}

	start(): void {
		this.store.recoverInterrupted(new Date().toISOString(), FAILURE_REPLY_TEXT);
		this.scheduleAgentDrain();
		this.scheduleStopDrain();
		this.scheduleDelivery();
	}

	acceptInstruction(instruction: ExternalInstruction): void {
		const stopPhrase = isStopPhrase(instruction.text);
		const result = this.store.acceptInstruction(instruction, stopPhrase, new Date().toISOString());
		if (result === "conflict") {
			throw new InstructionConflictError(
				`instruction_id ${instruction.instructionId} is already associated with different text`,
			);
		}
		if (result === "accepted") {
			if (stopPhrase) {
				this.scheduleStopDrain();
			} else {
				this.scheduleAgentDrain();
			}
		}
	}

	private scheduleAgentDrain(): void {
		if (this.closed || this.agentDrainPromise) {
			return;
		}
		this.agentDrainPromise = Promise.resolve()
			.then(async () => {
				while (!this.closed) {
					const instruction = this.store.claimNextNormalInstruction();
					if (!instruction) {
						return;
					}
					let replyText = FAILURE_REPLY_TEXT;
					try {
						const result = await this.agent.run(instruction.text);
						if (result.trim()) {
							replyText = result;
						}
					} catch {
						replyText = FAILURE_REPLY_TEXT;
					}
					this.store.completeInstruction(instruction.instructionId, replyText, new Date().toISOString());
					this.scheduleDelivery();
				}
			})
			.catch(this.onBackgroundError)
			.finally(() => {
				this.agentDrainPromise = undefined;
				if (!this.closed && this.store.hasPendingNormalInstruction()) {
					this.scheduleAgentDrain();
				}
			});
	}

	private scheduleStopDrain(): void {
		if (this.closed || this.stopDrainPromise) {
			return;
		}
		this.stopDrainPromise = Promise.resolve()
			.then(async () => {
				while (!this.closed) {
					const instruction = this.store.claimNextStopInstruction();
					if (!instruction) {
						return;
					}
					let replyText = STOP_ACCEPTED_REPLY_TEXT;
					try {
						await this.mcp.callTool("stop_all", {});
					} catch {
						replyText = FAILURE_REPLY_TEXT;
					}
					this.store.completeInstruction(instruction.instructionId, replyText, new Date().toISOString());
					this.scheduleDelivery();
				}
			})
			.catch(this.onBackgroundError)
			.finally(() => {
				this.stopDrainPromise = undefined;
				if (!this.closed && this.store.hasPendingStopInstruction()) {
					this.scheduleStopDrain();
				}
			});
	}

	private scheduleDelivery(): void {
		if (this.closed || this.deliveryPromise) {
			return;
		}
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		this.deliveryPromise = Promise.resolve()
			.then(async () => {
				while (!this.closed) {
					const pending = this.store.nextDueReply(Date.now());
					if (!pending) {
						return;
					}
					try {
						await this.replyClient.deliver(pending.event);
						this.store.markReplyDelivered(pending.event.reply_id, new Date().toISOString());
					} catch {
						const retryDelay = Math.min(this.retryBaseMs * 2 ** pending.attempts, this.retryMaxMs);
						const retryAt = Date.now() + retryDelay;
						this.store.markReplyFailed(pending.event.reply_id, retryAt);
						return;
					}
				}
			})
			.catch(this.onBackgroundError)
			.finally(() => {
				this.deliveryPromise = undefined;
				this.scheduleNextDeliveryWakeup();
			});
	}

	private scheduleNextDeliveryWakeup(): void {
		if (this.closed || this.deliveryPromise || this.retryTimer) {
			return;
		}
		const nextAttemptAtMs = this.store.nextUndeliveredAttemptAtMs();
		if (nextAttemptAtMs === undefined) {
			return;
		}
		const delayMs = Math.max(0, nextAttemptAtMs - Date.now());
		if (delayMs === 0) {
			this.scheduleDelivery();
			return;
		}
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.scheduleDelivery();
		}, delayMs);
		this.retryTimer.unref();
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		await Promise.all([this.agentDrainPromise, this.stopDrainPromise, this.deliveryPromise]);
		await this.agent.close?.();
		this.store.close();
	}
}

export function isStopPhrase(text: string): boolean {
	const normalized = text
		.normalize("NFKC")
		.trim()
		.replace(/[。.！!?？]+$/u, "")
		.trim()
		.toLowerCase();
	return normalized === "停" || normalized === "stop";
}
