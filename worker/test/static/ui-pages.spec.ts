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
		expect(js).toMatch(/\/api\/lookup\?q=\$\{encodeURIComponent\(/);
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
		for (const key of ["sources", "kind", "status", "signup_from", "signup_to", "cold", "has_app", "not_opened_days", "app_active_days", "min_site_visits"]) {
			expect(js, key).toMatch(new RegExp(String.raw`filters\.${key}\b|"${key}"`));
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
