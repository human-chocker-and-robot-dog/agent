import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

const UUID_SCHEMA = Type.String({ pattern: UUID_PATTERN });
const TIMESTAMP_SCHEMA = Type.String({ pattern: TIMESTAMP_PATTERN });
const SAFE_NON_NEGATIVE_INTEGER_SCHEMA = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER,
});
const DATA_SOURCE_SCHEMA = Type.Union([Type.Literal("live"), Type.Literal("replay"), Type.Literal("synthetic")]);
const EVENT_TYPE_SCHEMA = Type.Union([
	Type.Literal("lead_off"),
	Type.Literal("adc_clipping"),
	Type.Literal("input_stale"),
	Type.Literal("input_offline"),
]);

export const HEALTH_WEBHOOK_NOTIFICATION_SCHEMA = Type.Object(
	{
		schema_version: Type.Literal("0.2.0"),
		notification_id: UUID_SCHEMA,
		notification_sequence: SAFE_NON_NEGATIVE_INTEGER_SCHEMA,
		event_id: UUID_SCHEMA,
		event_revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		transition: Type.Union([Type.Literal("opened"), Type.Literal("resolved")]),
		event_type: EVENT_TYPE_SCHEMA,
		wearer_id: Type.String({
			minLength: 1,
			maxLength: 64,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
		}),
		source_instance_id: UUID_SCHEMA,
		state_revision: SAFE_NON_NEGATIVE_INTEGER_SCHEMA,
		data_source: DATA_SOURCE_SCHEMA,
		occurred_at: TIMESTAMP_SCHEMA,
		sent_at: TIMESTAMP_SCHEMA,
		trace_id: UUID_SCHEMA,
		test_mode: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export type HealthWebhookNotification = Static<typeof HEALTH_WEBHOOK_NOTIFICATION_SCHEMA>;
export type JsonObject = Record<string, unknown>;

export interface HealthMcpToolResult {
	isError: boolean;
	structuredContent: JsonObject;
}

export interface HealthMcpToolCaller {
	callTool(
		name: string,
		arguments_: Readonly<Record<string, unknown>>,
		signal?: AbortSignal,
	): Promise<HealthMcpToolResult>;
	close?(): Promise<void> | void;
}

export interface AuthoritativeHealthEvent {
	schemaVersion: "0.2.0";
	eventId: string;
	eventRevision: number;
	eventType: HealthWebhookNotification["event_type"];
	wearerId: string;
	sourceInstanceId: string;
	dataSource: HealthWebhookNotification["data_source"];
	testMode: boolean;
}

export interface AuthoritativeHealthState {
	schemaVersion: "0.2.0";
	wearerId: string;
	stateRevision: number;
	sourceInstanceId: string;
	dataSource: HealthWebhookNotification["data_source"];
	freshness: "fresh" | "stale" | "offline";
	testMode: boolean;
}

export class HealthMcpResultError extends Error {
	readonly retryable: boolean;
	readonly retryAfterMs: number | undefined;

	constructor(message: string, retryable = false, retryAfterMs?: number) {
		super(message);
		this.retryable = retryable;
		this.retryAfterMs = retryAfterMs;
	}
}

export function parseHealthWebhookNotification(value: unknown): HealthWebhookNotification {
	if (!Check(HEALTH_WEBHOOK_NOTIFICATION_SCHEMA, value)) {
		throw new Error("Health webhook body does not match contract 0.2.0");
	}
	if (!isValidContractTimestamp(value.occurred_at) || !isValidContractTimestamp(value.sent_at)) {
		throw new Error("Health webhook body contains an invalid timestamp");
	}
	if (value.data_source !== "live" && value.test_mode !== true) {
		throw new Error("Replay and synthetic notifications must be test_mode");
	}
	return value;
}

export function readAuthoritativeHealthEvent(result: HealthMcpToolResult): AuthoritativeHealthEvent {
	const event = readSuccessfulDataObject(result, "event");
	const eventType = event.event_type;
	const dataSource = event.data_source;
	if (
		event.schema_version !== "0.2.0" ||
		typeof event.event_id !== "string" ||
		!UUID_PATTERN_REGEX.test(event.event_id) ||
		!isSafeRevision(event.event_revision, 1) ||
		!isEventType(eventType) ||
		typeof event.wearer_id !== "string" ||
		typeof event.source_instance_id !== "string" ||
		!UUID_PATTERN_REGEX.test(event.source_instance_id) ||
		!isDataSource(dataSource) ||
		typeof event.test_mode !== "boolean"
	) {
		throw new HealthMcpResultError("Health MCP event result does not match contract 0.2.0");
	}
	return {
		schemaVersion: "0.2.0",
		eventId: event.event_id,
		eventRevision: event.event_revision,
		eventType,
		wearerId: event.wearer_id,
		sourceInstanceId: event.source_instance_id,
		dataSource,
		testMode: event.test_mode,
	};
}

export function readAuthoritativeHealthState(result: HealthMcpToolResult): AuthoritativeHealthState {
	const state = readSuccessfulDataObject(result, "state");
	const dataSource = state.data_source;
	const freshness = state.freshness;
	if (
		state.schema_version !== "0.2.0" ||
		typeof state.wearer_id !== "string" ||
		!isSafeRevision(state.state_revision, 0) ||
		typeof state.source_instance_id !== "string" ||
		!UUID_PATTERN_REGEX.test(state.source_instance_id) ||
		!isDataSource(dataSource) ||
		(freshness !== "fresh" && freshness !== "stale" && freshness !== "offline") ||
		typeof state.test_mode !== "boolean"
	) {
		throw new HealthMcpResultError("Health MCP state result does not match contract 0.2.0");
	}
	return {
		schemaVersion: "0.2.0",
		wearerId: state.wearer_id,
		stateRevision: state.state_revision,
		sourceInstanceId: state.source_instance_id,
		dataSource,
		freshness,
		testMode: state.test_mode,
	};
}

export function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSuccessfulDataObject(result: HealthMcpToolResult, field: string): JsonObject {
	if (result.isError || result.structuredContent.ok !== true) {
		const error = result.structuredContent.error;
		const retryable = isJsonObject(error) && error.retryable === true;
		const retryAfterMs =
			isJsonObject(error) && isSafeRevision(error.retry_after_ms, 0) ? error.retry_after_ms : undefined;
		throw new HealthMcpResultError("Health MCP returned a domain failure", retryable, retryAfterMs);
	}
	const data = result.structuredContent.data;
	if (!isJsonObject(data) || !isJsonObject(data[field])) {
		throw new HealthMcpResultError(`Health MCP result is missing data.${field}`);
	}
	return data[field];
}

function isValidContractTimestamp(value: string): boolean {
	if (!TIMESTAMP_PATTERN_REGEX.test(value)) {
		return false;
	}
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isSafeRevision(value: unknown, minimum: number): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= minimum;
}

function isDataSource(value: unknown): value is HealthWebhookNotification["data_source"] {
	return value === "live" || value === "replay" || value === "synthetic";
}

function isEventType(value: unknown): value is HealthWebhookNotification["event_type"] {
	return value === "lead_off" || value === "adc_clipping" || value === "input_stale" || value === "input_offline";
}

const UUID_PATTERN_REGEX = new RegExp(UUID_PATTERN, "u");
const TIMESTAMP_PATTERN_REGEX = new RegExp(TIMESTAMP_PATTERN, "u");
