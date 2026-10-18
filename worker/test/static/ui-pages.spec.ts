import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pub = resolve(import.meta.dirname, "../../public");
const read = (name: string) => readFileSync(join(pub, name), "utf8");

const inputs = (html: string) => [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
const hasId = (html: string, id: string) => new RegExp(`id="${id}"`).test(html);

describe("SPEC 2 Lookup page", () => {
	const html = read("lookup.html");
	const js = read("lookup.js");

	it("has exactly one search input, the #q box, inside a form with a submit button", () => {
		const found = inputs(html);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatch(/id="q"/);
		expect(html).toMatch(/<form id="search"[\s\S]*<button type="submit"/);
		expect(hasId(html, "results")).toBe(true);
		expect(html).toMatch(/<script[^>]*src="\/lookup\.js"/);
	});

	it("script reads #q, calls /api/lookup and renders Newsletter, Site visits and App activity cards", () => {
		expect(js).toMatch(/getElementById\("q"\)/);
		expect(js).toMatch(/postJson\(\s*"\/api\/lookup"\s*,\s*\{\s*q\s*\}/);
		expect(js).not.toMatch(/\/api\/lookup\?/);
		for (const title of ["Newsletter", "Site visits", "App activity"]) {
			expect(js).toMatch(new RegExp(String.raw`card\(\s*"${title}"`));
		}
	});
});

describe("SPEC 3 Segments page", () => {
	const html = read("segments.html");
	const js = read("segments.js");

	it("has a form control for every filter key", () => {
		expect(html).toMatch(/<form id="filters"/);
		for (const key of ["status", "signup_from", "signup_to", "cold", "not_opened_days", "has_app", "app_active_days", "min_site_visits"]) {
			expect(html, key).toMatch(new RegExp(String.raw`<(input|select)\b[^>]*name="${key}"`));
		}
		// sources and kind are checkbox groups that the script fills in.
		expect(hasId(html, "sources")).toBe(true);
		expect(hasId(html, "kinds")).toBe(true);
		expect(js).toMatch(/checkboxes\("sources", "sources"/);
		expect(js).toMatch(/checkboxes\("kinds", "kind"/);
		expect(js).toMatch(/box\.type = "checkbox"/);
		expect(html).toMatch(/<button type="submit"/);
	});

	it("has the count element and the results container", () => {
		expect(html).toMatch(/<p id="count"/);
		expect(hasId(html, "results")).toBe(true);
		expect(html).toMatch(/<script[^>]*src="\/segments\.js"/);
	});

	it("script reads every filter key into the filters object", () => {
		// sources and kind are assigned directly.
		for (const key of ["sources", "kind"]) {
			expect(js, key).toMatch(new RegExp(String.raw`filters\.${key}\s*=`));
		}
		// The rest are assigned as filters[key] inside a loop over a list that names the key.
		for (const key of ["status", "signup_from", "signup_to", "cold", "has_app", "not_opened_days", "app_active_days", "min_site_visits"]) {
			expect(js, key).toMatch(new RegExp(String.raw`for \(const key of \[[^\]]*"${key}"[^\]]*\]\) \{\s*if \([^
]*\) filters\[key\] =`));
		}
	});

	it("script POSTs { filters } to /api/segments/preview and renders the count and table rows", () => {
		expect(js).toMatch(/postJson\("\/api\/segments\/preview", \{ filters: readFilters\(\) \}\)/);
		expect(js).toMatch(/getElementById\("count"\)/);
		expect(js).toMatch(/count\.textContent = `\$\{body\.count\}/);
		expect(js).toMatch(/table\(\s*\[[^\]]*"Profile"[^\]]*\],\s*body\.rows\.map/);
		expect(js).toMatch(/results\.append\(/);
	});
});

describe("SPEC 5 and 6 Assistant page", () => {
	const html = read("assistant.html");
	const js = read("assistant.js");

	it("has a question form with one text control and a submit button, and loads its module", () => {
		expect(html).toMatch(/<form id="ask"[\s\S]*<button type="submit"/);
		expect(html).toMatch(/<(textarea|input)\b[^>]*id="question"/);
		expect(html).toMatch(/<script[^>]*type="module"[^>]*src="\/assistant\.js"/);
	});

	it("is linked from the nav of every page", () => {
		for (const page of ["index.html", "lookup.html", "segments.html", "assistant.html"]) {
			expect(read(page), page).toMatch(/<nav>[\s\S]*<a href="\/assistant">[^<]*<\/a>[\s\S]*<\/nav>/);
		}
	});

	it("has a 'How I read your question' plan area, an answer, and tells people that lookups belong on the Lookup page", () => {
		expect(html).toContain("How I read your question");
		expect(hasId(html, "plan")).toBe(true);
		expect(hasId(html, "answer")).toBe(true);
		expect(html).toMatch(/individual/i);
		expect(html).toMatch(/Lookup page/);
		expect(html).toMatch(/<main>[\s\S]*<a href="\/lookup">[\s\S]*<\/main>/);
	});

	it("has a chart canvas above the results table", () => {
		const canvas = html.search(/<canvas\b[^>]*id="chart"/);
		const results = html.search(/id="results"/);
		expect(canvas).toBeGreaterThan(-1);
		expect(results).toBeGreaterThan(canvas);
	});

	it("has a 'What the AI saw' toggle that shows model_request as text", () => {
		expect(html).toContain("What the AI saw");
		expect(html).toMatch(/<details\b[^>]*id="ai-saw"|<button\b[^>]*id="ai-saw-toggle"/);
		expect(hasId(html, "model-request")).toBe(true);
		expect(js).toMatch(/JSON\.stringify\(body\.model_request, null, 2\)/);
		expect(js).toMatch(/getElementById\("model-request"\)\.textContent\s*=/);
	});

	it("shows a plain message for a blocked_pii answer that points to the Lookup page", () => {
		expect(js).toMatch(/blocked_pii/);
		expect(js).toMatch(/Lookup page/);
	});

	it("posts { question } to /api/assistant and renders answer, plan, chart and rows", () => {
		expect(js).toMatch(/import \{[^}]*postJson[^}]*\} from "\/api\.js"/);
		expect(js).toMatch(/postJson\("\/api\/assistant", \{ question/);
		expect(js).toMatch(/getElementById\("answer"\)/);
		expect(js).toMatch(/getElementById\("plan"\)/);
		expect(js).toMatch(/result\.rows/);
		expect(js).toMatch(/result\.chart/);
		expect(js).toMatch(/table\(/);
	});

	it("shows the reason for an unsupported question with a link to the Segments page", () => {
		expect(js).toMatch(/"unsupported"/);
		expect(js).toMatch(/href\s*=\s*"\/segments"/);
	});

	it("does not offer 'Save as segment' (section 7 is a later run)", () => {
		expect(html + js).not.toMatch(/Save as segment|\/api\/segments"/i);
	});
});

describe("SPEC 6 charts: vendored Chart.js and one shared helper", () => {
	const vendored = "vendor/chart.umd.min.js";

	it("Chart.js is vendored at a pinned version under public/vendor/", () => {
		const text = read(vendored);
		expect(text.length).toBeGreaterThan(50_000);
		expect(text.slice(0, 400)).toMatch(/Chart\.js v4\.4\.1/);
	});

	it("both the assistant and Segments pages load the vendored file from /vendor/ and nothing from a CDN", () => {
		for (const page of ["assistant.html", "segments.html"]) {
			const html = read(page);
			expect(html, page).toMatch(/<script\b[^>]*src="\/vendor\/chart\.umd\.min\.js"/);
			expect(html, page).not.toMatch(/https?:\/\//);
			expect(html, page).toMatch(/<canvas\b[^>]*id="chart"/);
		}
	});

	it("both page scripts import the one shared chart helper, and only it constructs a Chart", () => {
		for (const file of ["assistant.js", "segments.js"]) {
			const js = read(file);
			expect(js, file).toMatch(/import \{[^}]*drawChart[^}]*\} from "\/charts\.js"/);
			expect(js, file).not.toMatch(/new Chart\(/);
		}
		const helper = read("charts.js");
		expect(helper).toMatch(/export function drawChart\(/);
		expect(helper).toMatch(/new window\.Chart\(|new Chart\(/);
		// A second draw replaces the first chart instead of stacking canvases.
		expect(helper).toMatch(/\.destroy\(\)/);
		expect(helper).not.toMatch(/innerHTML/);
	});

	it("the Segments page draws its chart from the preview's by_source data", () => {
		const js = read("segments.js");
		expect(js).toMatch(/drawChart\([^)]*body\.chart\.by_source/);
	});

	it("the CSP stays script-src 'self' (no CDN origin was added)", () => {
		const csp = readFileSync(join(pub, "../src/http/security.ts"), "utf8");
		expect(csp).toContain("script-src 'self';");
		expect(csp).not.toMatch(/jsdelivr|cdnjs|unpkg/);
	});
});
