import { json } from "../http/security";
import { validateFilters } from "../segments/filters";
import { previewSegment } from "../segments/query";

/** POST /api/segments/preview {filters}. Invalid filters get 400 and no SQL runs. */
export async function handlePreview(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "invalid_filters", reason: "body must be JSON" }, 400);
	}
	if (typeof body !== "object" || body === null || !("filters" in body)) {
		return json({ error: "invalid_filters", reason: "body needs a filters object" }, 400);
	}
	const checked = validateFilters((body as { filters: unknown }).filters);
	if (!checked.ok) return json({ error: "invalid_filters", reason: checked.error }, 400);
	return json(await previewSegment(env.tpo_cdp, checked.filters));
}
