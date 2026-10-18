import { KINDS, SOURCES, STATUSES } from "../segments/filters";
import { LAST_30_START, LAST_7_START, TODAY } from "../lib/time";
import { SITE_PAGES } from "./tools";

export const MODEL_ID = "claude-haiku-5-5";
export const MAX_TOKENS = 512;

export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
}

export interface ModelRequestBody {
	model: string;
	max_tokens: number;
	system: string;
	tools: ToolDefinition[];
	tool_choice: { type: "any" };
	messages: { role: "user"; content: string }[];
}

/** First and last day of the calendar month before TODAY's month. */
function lastMonth(today: string): { start: string; end: string } {
	const [year, month] = today.split("-").map(Number);
	const start = new Date(Date.UTC(year, month - 2, 1));
	const end = new Date(Date.UTC(year, month - 1, 0));
	return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

const LAST_MONTH = lastMonth(TODAY);

/** The role, TODAY, the shared definitions, the filter vocabulary, the kinds, the pages and the event types. No rows, no results. */
const SYSTEM_PROMPT = [
	"You turn one question about a newsletter audience into exactly one tool call. You never answer in prose and you never see results: the server runs the tool and writes the answer from a fixed template.",
	"Today is " + TODAY + ". Dates are YYYY-MM-DD.",
	"Definitions:",
	"- Last 30 days: dates on or after " + LAST_30_START + ". Last 7 days: dates on or after " + LAST_7_START + ".",
	"- Last month: " + LAST_MONTH.start + " to " + LAST_MONTH.end + ".",
	"- Cold: status is active AND (last open before " + LAST_30_START + ", or never opened and signed up before " + LAST_30_START + "). Unsubscribed people are never cold.",
	"- New subscriber: signed up on or after " + LAST_30_START + ".",
	"- Sources (lowercase, twitter is x): " + SOURCES.join(", ") + ".",
	"- Status: " + STATUSES.join(" or ") + ".",
	"- Profile kinds: " + KINDS.join(", ") + ".",
	"- Pages on the site: " + [...SITE_PAGES, "/beliefs", "/our-staff", "/shadrachs-picks"].join(", ") + ", and articles under /news/<slug>.",
	"- App event types: app_open, read_story, link_click, login.",
	"Tools:",
	"- count_profiles(filters): how many profiles match.",
	"- build_segment(filters): a list of matching profiles with a chart by source.",
	"- top_pages(filters, mode, limit, include_site_pages): the most visited pages. Site pages are exactly: " + SITE_PAGES.join(", ") + " (every other page is a content page). Site pages are left out unless include_site_pages is true; set it to true only when the question asks about the home, subscribe or about pages. mode 'all' counts every page the matching profiles visited; mode 'first_visit' counts the first page each matching profile ever visited.",
	"- breakdown(by, filters): counts grouped by source, status, signup_month, kind or cold.",
	"- engagement_ranking(limit, filters): the most engaged profiles.",
	"- unsupported(reason): use this when no tool fits, for example a question about one named person, a comparison that needs two steps, or anything that is not about these filters. Give a short reason and suggest the Segments page.",
	"The question has [email] or [id] wherever a private value was removed. Never ask for such values and never guess them.",
].join("\n");

const FILTERS_SCHEMA = {
	type: "object",
	description: "Optional filters. Leave out any filter the question does not mention.",
	additionalProperties: false,
	properties: {
		sources: { type: "array", items: { type: "string", enum: [...SOURCES] }, description: "Acquisition sources." },
		status: { type: "string", enum: [...STATUSES] },
		signup_from: { type: "string", description: "First signup date, inclusive, YYYY-MM-DD." },
		signup_to: { type: "string", description: "Last signup date, inclusive, YYYY-MM-DD." },
		cold: { type: "boolean", description: "true for cold subscribers, false for the rest." },
		not_opened_days: { type: "integer", minimum: 1, maximum: 365, description: "Has not opened in this many days." },
		kind: { type: "array", items: { type: "string", enum: [...KINDS] } },
		has_app: { type: "boolean", description: "Has an app account." },
		app_active_days: { type: "integer", minimum: 1, maximum: 365, description: "Had app activity in the last N days." },
		min_site_visits: { type: "integer", minimum: 0, maximum: 10000, description: "At least this many site visits in the last 30 days." },
	},
};

const TOOLS: ToolDefinition[] = [
	{
		name: "count_profiles",
		description: "Count the profiles that match the filters.",
		input_schema: { type: "object", properties: { filters: FILTERS_SCHEMA }, additionalProperties: false },
	},
	{
		name: "build_segment",
		description: "List the profiles that match the filters, best engagement first, with a chart by source.",
		input_schema: { type: "object", properties: { filters: FILTERS_SCHEMA }, additionalProperties: false },
	},
	{
		name: "top_pages",
		description: "The most visited pages for the profiles that match the filters.",
		input_schema: {
			type: "object",
			properties: {
				filters: FILTERS_SCHEMA,
				mode: { type: "string", enum: ["all", "first_visit"], description: "all = every visit, first_visit = the first page each profile ever visited." },
				limit: { type: "integer", minimum: 1, maximum: 20, description: "How many pages to return. Default 10." },
					include_site_pages: {
						type: "boolean",
						description: "Default false. Set true only when the question asks about the home, subscribe or about pages; otherwise leave it out.",
					},
			},
			required: ["mode"],
			additionalProperties: false,
		},
	},
	{
		name: "breakdown",
		description: "Count the matching profiles grouped by one field.",
		input_schema: {
			type: "object",
			properties: {
				by: { type: "string", enum: ["source", "status", "signup_month", "kind", "cold"] },
				filters: FILTERS_SCHEMA,
			},
			required: ["by"],
			additionalProperties: false,
		},
	},
	{
		name: "engagement_ranking",
		description: "Rank the matching profiles by engagement score, best first.",
		input_schema: {
			type: "object",
			properties: {
				limit: { type: "integer", minimum: 1, maximum: 100, description: "How many profiles to return. Default 50." },
				filters: FILTERS_SCHEMA,
			},
			additionalProperties: false,
		},
	},
	{
		name: "unsupported",
		description: "Use when no other tool fits the question.",
		input_schema: {
			type: "object",
			properties: { reason: { type: "string", description: "One short sentence on why, suggesting the Segments page." } },
			required: ["reason"],
			additionalProperties: false,
		},
	},
];

/** The exact request body for one scrubbed question. This object is what the "What the AI saw" panel shows. */
export function buildModelRequest(scrubbedQuestion: string): ModelRequestBody {
	return {
		model: MODEL_ID,
		max_tokens: MAX_TOKENS,
		system: SYSTEM_PROMPT,
		tools: TOOLS,
		tool_choice: { type: "any" },
		messages: [{ role: "user", content: scrubbedQuestion }],
	};
}
