import type { ModelRequestBody } from "./prompt";
import { containsPrivateValue } from "./scrub";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 20_000;

/** The request body held an email or an id. Nothing was sent. */
export class PiiBlockedError extends Error {
	constructor() {
		super("request body held private values");
		this.name = "PiiBlockedError";
	}
}

/** The model call failed, timed out or returned something unreadable. */
export class ModelUnavailableError extends Error {
	constructor() {
		super("model unavailable");
		this.name = "ModelUnavailableError";
	}
}

export interface ModelDeps {
	/** Only ANTHROPIC_API_KEY is read, and only in this file. */
	env: { ANTHROPIC_API_KEY: string };
	/** Defaults to the global fetch. Tests pass their own. */
	fetch?: typeof fetch;
}

/** The error.type of an API error body, or "unknown". Nothing else from the body is read. */
async function apiErrorType(response: Response): Promise<string> {
	try {
		const parsed = (await response.json()) as { error?: { type?: unknown } } | null;
		const type = parsed?.error?.type;
		return typeof type === "string" && /^[a-z_]{1,64}$/.test(type) ? type : "unknown";
	} catch {
		return "unknown";
	}
}

/** The tool call the model chose. */
export interface ModelPlan {
	name: string;
	input: unknown;
}

/**
 * The only code that calls the model or reads ANTHROPIC_API_KEY. It serializes the whole body and scans it for an
 * email or an id before anything leaves the Worker; a hit throws PiiBlockedError with no network call.
 * Returns the first tool_use block (text blocks are ignored), or null when the reply has none.
 */
export async function sendToModel(body: ModelRequestBody, deps: ModelDeps): Promise<ModelPlan | null> {
	const text = JSON.stringify(body);
	if (containsPrivateValue(text)) throw new PiiBlockedError();

	const send = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	let reply: unknown;
	try {
		const response = await send(MESSAGES_URL, {
			method: "POST",
			headers: {
				"x-api-key": deps.env.ANTHROPIC_API_KEY,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: text,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) {
			console.error(`model call failed: status ${response.status} error.type ${await apiErrorType(response)}`);
			throw new ModelUnavailableError();
		}
		reply = await response.json();
	} catch (error) {
		if (error instanceof ModelUnavailableError) throw error;
		console.error("model call failed:", error instanceof Error ? error.name : "UnknownError");
		throw new ModelUnavailableError();
	}

	const content = typeof reply === "object" && reply !== null ? (reply as { content?: unknown }).content : undefined;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_use") {
			const { name, input } = block as { name?: unknown; input?: unknown };
			return typeof name === "string" ? { name, input } : null;
		}
	}
	return null;
}
