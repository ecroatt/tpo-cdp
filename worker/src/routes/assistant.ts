import { ModelUnavailableError, PiiBlockedError, sendToModel } from "../assistant/model";
import { questionNamesSomeone } from "../assistant/names";
import { buildModelRequest } from "../assistant/prompt";
import { hasDisguisedEmail, scrubQuestion } from "../assistant/scrub";
import { answerFor } from "../assistant/templates";
import { runTool, validatePlan } from "../assistant/tools";
import { json } from "../http/security";
import { clientKey, type Limiter } from "../lib/limiter";

const QUESTION_MAX = 500;

export interface AssistantDeps {
	/** The model call goes through this fetch. Defaults to the global fetch; tests pass a scripted one. */
	fetch?: typeof fetch;
	/** Defaults to scrubQuestion. Tests swap it to prove the guard in sendToModel is the last line of defense. */
	scrub?: (question: string) => string;
	/** Defaults to questionNamesSomeone. Tests that touch no database swap it for a stub. */
	names?: (db: D1Database, question: string) => Promise<boolean>;
}

/**
 * POST /api/assistant {question}. Scrub, one model call, validate the plan, run it, answer from a template.
 * The model only ever sees the scrubbed question (never results), and the browser gets the exact request body
 * back as `model_request`. An invalid plan gets 422 and no SQL runs.
 */
export async function handleAssistant(request: Request, env: Env, deps: AssistantDeps = {}): Promise<Response> {
	// 20 questions per 60 s per IP, checked before anything else.
	const limiter = env.ASSISTANT_LIMITER as Limiter;
	if (!(await limiter.limit({ key: clientKey(request) })).success) {
		return json({ error: "rate_limited" }, 429, { "Retry-After": "60" });
	}

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return json({ error: "invalid_question" }, 400);
	}
	const question = typeof payload === "object" && payload !== null ? (payload as { question?: unknown }).question : undefined;
	if (typeof question !== "string" || question.trim() === "" || question.length > QUESTION_MAX) {
		return json({ error: "invalid_question" }, 400);
	}

	// An address written so the scrubber cannot replace it (spaces around "@", %40, "jane at gmail dot com") is
	// refused outright: no model call and no SQL.
	const scrubbed = (deps.scrub ?? scrubQuestion)(question.trim());
	if (hasDisguisedEmail(scrubbed)) return json({ error: "blocked_pii" }, 422);

	// Two adjacent words that are the first and last name from a stored email: refused outright too.
	if (await (deps.names ?? questionNamesSomeone)(env.tpo_cdp, question)) return json({ error: "blocked_pii" }, 422);

	const body = buildModelRequest(scrubbed);
	let reply;
	try {
		reply = await sendToModel(body, { env, fetch: deps.fetch });
	} catch (err) {
		if (err instanceof PiiBlockedError) return json({ error: "blocked_pii" }, 422);
		if (err instanceof ModelUnavailableError) return json({ error: "assistant_unavailable" }, 502);
		throw err;
	}

	const checked = reply === null ? ({ ok: false } as const) : validatePlan(reply.name, reply.input);
	if (!checked.ok) return json({ error: "unsupported_question" }, 422);

	const result = await runTool(env.tpo_cdp, checked.plan);
	return json({
		answer: answerFor(result),
		plan: { tool: checked.plan.tool, params: checked.plan.params },
		result,
		model_request: body,
	});
}
