import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentReplyEvent, ExternalInstruction } from "./types.ts";

type InstructionRow = {
	instruction_id: string;
	text: string;
	is_stop: number;
};

type OutboxRow = {
	reply_id: string;
	instruction_id: string;
	text: string;
	completed_at: string;
	attempts: number;
};

export type AcceptInstructionResult = "accepted" | "duplicate" | "conflict";
export interface PendingReply {
	event: AgentReplyEvent;
	attempts: number;
}

export class GatewayStore {
	private readonly database: DatabaseSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.database = new DatabaseSync(path);
		this.database.exec("PRAGMA journal_mode = WAL");
		this.database.exec("PRAGMA foreign_keys = ON");
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS instructions (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				instruction_id TEXT NOT NULL UNIQUE,
				text TEXT NOT NULL,
				is_stop INTEGER NOT NULL CHECK (is_stop IN (0, 1)),
				status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')),
				received_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS outbox (
				reply_id TEXT PRIMARY KEY,
				instruction_id TEXT NOT NULL UNIQUE REFERENCES instructions(instruction_id),
				text TEXT NOT NULL,
				completed_at TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
				delivered_at TEXT
			);
		`);
	}

	acceptInstruction(instruction: ExternalInstruction, isStop: boolean, receivedAt: string): AcceptInstructionResult {
		const existing = this.database
			.prepare("SELECT text FROM instructions WHERE instruction_id = ?")
			.get(instruction.instructionId) as { text: string } | undefined;
		if (existing) {
			return existing.text === instruction.text ? "duplicate" : "conflict";
		}

		this.database
			.prepare(
				`INSERT INTO instructions (instruction_id, text, is_stop, status, received_at)
				 VALUES (?, ?, ?, 'pending', ?)`,
			)
			.run(instruction.instructionId, instruction.text, isStop ? 1 : 0, receivedAt);
		return "accepted";
	}

	claimNextNormalInstruction(): ExternalInstruction | undefined {
		return this.claimNext("is_stop = 0");
	}

	claimNextStopInstruction(): ExternalInstruction | undefined {
		return this.claimNext("is_stop = 1");
	}

	private claimNext(filter: string): ExternalInstruction | undefined {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.database
				.prepare(
					`SELECT instruction_id, text, is_stop
					 FROM instructions
					 WHERE status = 'pending' AND ${filter}
					 ORDER BY sequence
					 LIMIT 1`,
				)
				.get() as InstructionRow | undefined;
			if (!row) {
				this.database.exec("COMMIT");
				return undefined;
			}
			this.database
				.prepare("UPDATE instructions SET status = 'processing' WHERE instruction_id = ? AND status = 'pending'")
				.run(row.instruction_id);
			this.database.exec("COMMIT");
			return { instructionId: row.instruction_id, text: row.text };
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	completeInstruction(instructionId: string, text: string, completedAt: string): AgentReplyEvent {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.database
				.prepare(
					`SELECT reply_id, instruction_id, text, completed_at, attempts
					 FROM outbox
					 WHERE instruction_id = ?`,
				)
				.get(instructionId) as OutboxRow | undefined;
			if (existing) {
				this.database.exec("COMMIT");
				return this.toReplyEvent(existing);
			}

			const replyId = randomUUID();
			this.database
				.prepare(
					`INSERT INTO outbox (reply_id, instruction_id, text, completed_at)
					 VALUES (?, ?, ?, ?)`,
				)
				.run(replyId, instructionId, text, completedAt);
			this.database
				.prepare("UPDATE instructions SET status = 'completed' WHERE instruction_id = ?")
				.run(instructionId);
			this.database.exec("COMMIT");
			return {
				event: "agent.reply.completed",
				reply_id: replyId,
				instruction_id: instructionId,
				text,
				completed_at: completedAt,
			};
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	nextDueReply(nowMs: number): PendingReply | undefined {
		const row = this.database
			.prepare(
				`SELECT reply_id, instruction_id, text, completed_at, attempts
				 FROM outbox
				 WHERE delivered_at IS NULL AND next_attempt_at_ms <= ?
				 ORDER BY completed_at, reply_id
				 LIMIT 1`,
			)
			.get(nowMs) as OutboxRow | undefined;
		return row ? { event: this.toReplyEvent(row), attempts: row.attempts } : undefined;
	}

	nextUndeliveredAttemptAtMs(): number | undefined {
		const row = this.database
			.prepare(
				`SELECT MIN(next_attempt_at_ms) AS next_attempt_at_ms
				 FROM outbox
				 WHERE delivered_at IS NULL`,
			)
			.get() as { next_attempt_at_ms: number | null };
		return row.next_attempt_at_ms ?? undefined;
	}

	markReplyDelivered(replyId: string, deliveredAt: string): void {
		this.database.prepare("UPDATE outbox SET delivered_at = ? WHERE reply_id = ?").run(deliveredAt, replyId);
	}

	markReplyFailed(replyId: string, nextAttemptAtMs: number): void {
		this.database
			.prepare(
				`UPDATE outbox
				 SET attempts = attempts + 1, next_attempt_at_ms = ?
				 WHERE reply_id = ? AND delivered_at IS NULL`,
			)
			.run(nextAttemptAtMs, replyId);
	}

	hasPendingNormalInstruction(): boolean {
		return this.hasPending("is_stop = 0");
	}

	hasPendingStopInstruction(): boolean {
		return this.hasPending("is_stop = 1");
	}

	private hasPending(filter: string): boolean {
		return (
			this.database
				.prepare(`SELECT 1 AS present FROM instructions WHERE status = 'pending' AND ${filter} LIMIT 1`)
				.get() !== undefined
		);
	}

	recoverInterrupted(completedAt: string, fallbackText: string): void {
		const rows = this.database
			.prepare("SELECT instruction_id FROM instructions WHERE status = 'processing' ORDER BY sequence")
			.all() as Array<{ instruction_id: string }>;
		for (const row of rows) {
			this.completeInstruction(row.instruction_id, fallbackText, completedAt);
		}
	}

	close(): void {
		this.database.close();
	}

	private toReplyEvent(row: OutboxRow): AgentReplyEvent {
		return {
			event: "agent.reply.completed",
			reply_id: row.reply_id,
			instruction_id: row.instruction_id,
			text: row.text,
			completed_at: row.completed_at,
		};
	}
}
