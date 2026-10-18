import type { Filters } from "../segments/filters";
import { SITE_PAGES, type ToolResult } from "./tools";

const capitalize = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** The filters in words, in the order of the filter table. "no filters" when there are none. */
export function describeFilters(filters: Filters): string {
	const parts: string[] = [];
	if (filters.sources !== undefined) parts.push(filters.sources.map(capitalize).join(" or "));
	if (filters.status !== undefined) parts.push(filters.status);
	if (filters.signup_from !== undefined && filters.signup_to !== undefined) parts.push(`signed up ${filters.signup_from} to ${filters.signup_to}`);
	else if (filters.signup_from !== undefined) parts.push("signed up from " + filters.signup_from);
	else if (filters.signup_to !== undefined) parts.push("signed up on or before " + filters.signup_to);
	if (filters.cold !== undefined) parts.push(filters.cold ? "cold" : "not cold");
	if (filters.not_opened_days !== undefined) parts.push("not opened in " + filters.not_opened_days + " days");
	if (filters.kind !== undefined) parts.push("kind " + filters.kind.join(" or "));
	if (filters.has_app !== undefined) parts.push(filters.has_app ? "with an app account" : "without an app account");
	if (filters.app_active_days !== undefined) parts.push("active in the app in the last " + filters.app_active_days + " days");
	if (filters.min_site_visits !== undefined) parts.push("at least " + filters.min_site_visits + " site visits in the last 30 days");
	return parts.length === 0 ? "no filters" : parts.join(", ");
}

function countSentence(count: number, filters: Filters): string {
	const verb = count === 1 ? "profile matches" : "profiles match";
	return count + " " + verb + ": " + describeFilters(filters) + ".";
}

/**
 * The answer sentence, from a fixed template per tool and the real result. The model never sees results,
 * so it never writes this text.
 */
export function answerFor(result: ToolResult): string {
	const { tool, params } = result;
	const rows = result.rows ?? [];
	const count = result.count ?? 0;
	switch (tool) {
		case "count_profiles":
			return countSentence(count, (params as { filters: Filters }).filters);
		case "build_segment": {
			const sentence = countSentence(count, (params as { filters: Filters }).filters);
			return rows.length === 0 ? sentence : `${sentence} Showing the top ${rows.length} by engagement score.`;
		}
		case "top_pages": {
			const { filters, mode, include_site_pages } = params as { filters: Filters; mode: "all" | "first_visit"; include_site_pages: boolean };
				const leftOut = include_site_pages ? "" : ` Leaves out site pages: ${SITE_PAGES.join(", ")}.`;
			const desc = describeFilters(filters);
			if (rows.length === 0) return `No pages found for profiles matching ${desc}.${leftOut}`;
			const list = (rows as { page: string; profiles: number }[]).map((r) => `${r.page} (${r.profiles})`).join(", ");
			const noun = mode === "first_visit" ? "first pages" : "pages";
			return `Top ${rows.length} ${noun} for profiles matching ${desc}: ${list}.${leftOut}`;
		}
		case "breakdown": {
			const { by, filters } = params as { by: string; filters: Filters };
			if (rows.length === 0) return countSentence(0, filters);
			const list = (rows as { group: string; count: number }[]).map((r) => `${r.group} (${r.count})`).join(", ");
			return `Breakdown by ${by.replace("_", " ")} for profiles matching ${describeFilters(filters)}: ${list}.`;
		}
		case "engagement_ranking": {
			const { filters } = params as { filters: Filters };
			return `Top ${rows.length} of ${count} profiles by engagement score, matching ${describeFilters(filters)}.`;
		}
		case "unsupported":
			return (params as { reason: string }).reason;
	}
}
