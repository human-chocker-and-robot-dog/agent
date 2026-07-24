import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type HealthWebhookNotification, parseHealthWebhookNotification } from "./health-contract.ts";
import type { HealthNotificationService } from "./health-service.ts";
import type { GatewayStore } from "./store.ts";

const HEALTH_WEBHOOK_PATH = "/v1/health-events";
const MAX_BODY_BYTES = 65_536;
const TIMESTAMP_PATTERN = /^[1-9][0-9]{0,11}$/u;
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/u;
const CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8\s*)?$/iu;

export interface HealthWebhookReceiverOptions {
	store: GatewayStore;
	healthService: HealthNotificationService;
	keys: ReadonlyMap<string, Uint8Array>;
	nowEpochSeconds?: () => number;
}

export class HealthWebhookReceiver {
	private readonly store: GatewayStore;
	private readonly healthService: HealthNotificationService;
	private readonly keys: ReadonlyMap<string, Uint8Array>;
	private readonly nowEpochSeconds: () => number;

	constructor(options: HealthWebhookReceiverOptions) {
		if (options.keys.size === 0) {
			throw new Error("At least one Health webhook key is required");
		}
		for (const [keyId, secret] of options.keys) {
			if (!keyId || secret.byteLength !== 32) {
				throw new Error("Health webhook keys require a non-empty key ID and exactly 32 secret bytes");
			}
		}
		this.store = options.store;
		this.healthService = options.healthService;
		this.keys = options.keys;
		this.nowEpochSeconds = options.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1000));
	}

	async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") {
			sendJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
			return;
		}
		if (request.url !== HEALTH_WEBHOOK_PATH) {
			sendJson(response, 404, { error: "not_found" });
			return;
		}
		if (!isAcceptedContentType(readSingleHeader(request, "content-type"))) {
			sendJson(response, 415, { error: "unsupported_media_type" });
			return;
		}

		const contentLengthText = readSingleHeader(request, "content-length");
		if (
			request.headers["transfer-encoding"] !== undefined ||
			contentLengthText === undefined ||
			!/^[0-9]+$/u.test(contentLengthText)
		) {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}
		const contentLength = Number(contentLengthText);
		if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}
		if (contentLength > MAX_BODY_BYTES) {
			sendJson(response, 413, { error: "body_too_large" });
			return;
		}

		let rawBody: Buffer;
		try {
			rawBody = await readRawBody(request);
		} catch {
			sendJson(response, 413, { error: "body_too_large" });
			return;
		}
		if (rawBody.length !== contentLength) {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}

		const timestamp = readSingleHeader(request, "x-smart-collar-timestamp");
		if (!timestamp || !TIMESTAMP_PATTERN.test(timestamp)) {
			sendJson(response, 401, { error: "timestamp_out_of_range" });
			return;
		}
		const timestampNumber = Number(timestamp);
		if (
			!Number.isSafeInteger(timestampNumber) ||
			timestampNumber < 1 ||
			timestampNumber > 253_402_300_799 ||
			Math.abs(this.nowEpochSeconds() - timestampNumber) > 300
		) {
			sendJson(response, 401, { error: "timestamp_out_of_range" });
			return;
		}

		const keyId = readSingleHeader(request, "x-smart-collar-key-id");
		const signature = readSingleHeader(request, "x-smart-collar-signature");
		const secret = keyId ? this.keys.get(keyId) : undefined;
		if (!secret || !signature || !verifySignature(secret, timestamp, rawBody, signature)) {
			sendJson(response, 401, { error: "invalid_signature" });
			return;
		}

		let notification: HealthWebhookNotification;
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
			notification = parseHealthWebhookNotification(JSON.parse(text));
		} catch {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}

		const notificationIdHeader = readSingleHeader(request, "x-smart-collar-notification-id");
		if (notificationIdHeader !== notification.notification_id) {
			sendJson(response, 400, { error: "invalid_request" });
			return;
		}

		try {
			const digest = createHash("sha256").update(rawBody).digest("hex");
			const outcome = this.store.acceptHealthNotification(notification, rawBody, digest, new Date().toISOString());
			if (outcome === "conflict") {
				sendJson(response, 409, { error: "notification_id_conflict" });
				return;
			}
			if (outcome === "accepted") {
				this.healthService.notifyAccepted();
			}
			sendJson(response, 202, {
				notification_id: notification.notification_id,
				status: outcome,
			});
		} catch {
			sendJson(response, 503, { error: "internal_error" });
		}
	}
}

function verifySignature(secret: Uint8Array, timestamp: string, rawBody: Buffer, signature: string): boolean {
	const match = SIGNATURE_PATTERN.exec(signature);
	if (!match) {
		return false;
	}
	const expected = createHmac("sha256", secret)
		.update(Buffer.from(`${timestamp}.`, "ascii"))
		.update(rawBody)
		.digest();
	const provided = Buffer.from(match[1], "hex");
	return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_BODY_BYTES) {
			throw new Error("Health webhook body is too large");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, bytes);
}

function isAcceptedContentType(value: string | undefined): boolean {
	return value !== undefined && CONTENT_TYPE_PATTERN.test(value);
}

function readSingleHeader(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return typeof value === "string" ? value : undefined;
}

function sendJson(
	response: ServerResponse,
	statusCode: number,
	body: Readonly<Record<string, unknown>>,
	headers: Readonly<Record<string, string>> = {},
): void {
	response.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		...headers,
	});
	response.end(JSON.stringify(body));
}
