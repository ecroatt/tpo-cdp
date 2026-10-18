// SPEC 9: home page, prefill and visual refresh. Static checks on public/ plus prefill.js run in Node.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const pub = resolve(import.meta.dirname, "../../public");
const read = (name: string) => readFileSync(join(pub, name), "utf8");

const QUESTIONS = [
	"How many Instagram signups went cold last month?",
	"Build me a list of our most engaged readers",
	"Which pages do new subscribers hit first?",
	"Signups by month",
];

interface Fake {
	value: string;
	calls: string[];
	[key: string]: unknown;
}

/** A fake textarea and its fake form that record every submit-like call. */
function fakeTextarea(initial = ""): Fake {
	const calls: string[] = [];
	const record = (name: string) => () => {
		calls.push(name);
	};
	const form = { submit: record("form.submit"), requestSubmit: record("form.requestSubmit"), click: record("form.click"), dispatchEvent: record("form.dispatchEvent") };
	return { value: initial, calls, form, submit: record("submit"), requestSubmit: record("requestSubmit"), click: record("click"), dispatchEvent: record("dispatchEvent") };
}

async function loadPrefill(): Promise<(search: string, textarea: unknown) => void> {
	const module = await import(/* @vite-ignore */ pathToFileURL(resolve(pub, "prefill.js")).href);
	return module.prefillQuestion;
}

describe("prefillQuestion", () => {
	it("sets the textarea from ?q= and does nothing else", async () => {
		const fetchStub = vi.fn();
		vi.stubGlobal("fetch", fetchStub);
		const prefillQuestion = await loadPrefill();
		const fake = fakeTextarea();
		prefillQuestion("?q=Signups%20by%20month", fake);
		expect(fake.value).toBe("Signups by month");
		expect(fake.calls).toEqual([]);
		expect(fetchStub).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("cuts a 600-character q to 500", async () => {
		const prefillQuestion = await loadPrefill();
		const fake = fakeTextarea();
		prefillQuestion("?q=" + "a".repeat(600), fake);
		expect(fake.value).toBe("a".repeat(500));
		expect(fake.calls).toEqual([]);
	});

	it("leaves value unchanged with no q or an empty q", async () => {
		const prefillQuestion = await loadPrefill();
		for (const search of ["", "?other=1", "?q=", "?q=&x=1"]) {
			const fake = fakeTextarea("keep me");
			prefillQuestion(search, fake);
			expect(fake.value, search).toBe("keep me");
			expect(fake.calls, search).toEqual([]);
		}
	});

	it("decodes the Try asking encoding for each example question", async () => {
		const prefillQuestion = await loadPrefill();
		for (const question of QUESTIONS) {
			const fake = fakeTextarea();
			prefillQuestion("?q=" + encodeURIComponent(question), fake);
			expect(fake.value).toBe(question);
		}
	});
});

describe("assistant.js and prefill.js source", () => {
	it("assistant.js imports prefillQuestion from /prefill.js and calls it with location.search and the textarea", () => {
		const js = read("assistant.js");
		expect(js).toMatch(/import\s*\{\s*prefillQuestion\s*\}\s*from\s*"\/prefill\.js"/);
		expect(js).toMatch(/prefillQuestion\(\s*location\.search\s*,\s*input\s*\)/);
		expect(js).toMatch(/const input = document\.getElementById\("question"\)/);
	});

	it("prefill.js has no imports and nothing that could send a question", () => {
		const js = read("prefill.js");
		expect(js).not.toMatch(/^\s*import\b/m);
		for (const word of ["fetch", "postJson", "submit", "requestSubmit", "click(", "dispatchEvent"]) {
			expect(js, word).not.toContain(word);
		}
	});
});

describe("index.html", () => {
	const html = read("index.html");

	it("has four tiles", () => {
		for (const id of ["tile-people", "tile-active-subscribers", "tile-app-users", "tile-app-events"]) {
			expect(html, id).toContain(`id="${id}"`);
		}
		for (const label of ["People", "Active newsletter subscribers", "App users linked to a profile", "App events, last 30 days"]) {
			expect(html, label).toContain(label);
		}
	});

	it("has the three Start here links with their sentences", () => {
		expect(html).toContain("Start here");
		expect(html).toMatch(/href="\/lookup"[^>]*>[\s\S]*?Check one person: their newsletter status, site visits, app activity and engagement score\./);
		expect(html).toMatch(/href="\/segments"[^>]*>[\s\S]*?Build an audience by source, signup date, opens and app use, and see who is in it\./);
		expect(html).toMatch(/href="\/assistant"[^>]*>[\s\S]*?Ask a question about the whole audience in plain English and get a number, a table or a chart\./);
	});

	it("has four /assistant?q= links whose decoded q values are the four questions", () => {
		const hrefs = [...html.matchAll(/href="(\/assistant\?q=[^"]*)"/g)].map((m) => m[1]);
		expect(hrefs).toHaveLength(4);
		const decoded = hrefs.map((h) => new URL(h, "https://cdp.test").searchParams.get("q"));
		expect(decoded).toEqual(QUESTIONS);
		expect(html).toContain("Try asking");
	});

	it("has a Last import heading after them with #run-at and #report", () => {
		const last = html.indexOf("Last import");
		expect(last).toBeGreaterThan(html.indexOf("Try asking"));
		expect(last).toBeGreaterThan(html.indexOf("Start here"));
		expect(last).toBeGreaterThan(html.indexOf('id="tile-app-events"'));
		expect(html.indexOf('id="run-at"')).toBeGreaterThan(last);
		expect(html.indexOf('id="report"')).toBeGreaterThan(last);
		expect(html).toContain("A data health check: what the last CSV import read, skipped, merged and linked.");
	});
});

describe("home.js", () => {
	const js = read("home.js");

	it("fetches /api/overview and /api/import-report", () => {
		expect(js).toContain("/api/overview");
		expect(js).toContain("/api/import-report");
		expect(js).toContain('toLocaleString("en-US")');
	});

	it("has a label for every metric key written in src/import/build.ts", () => {
		const build = readFileSync(resolve(import.meta.dirname, "../../src/import/build.ts"), "utf8");
		const keys = new Set<string>();
		for (const m of build.matchAll(/counts\.(\w+)\s*=/g)) keys.add(m[1]);
		for (const m of build.matchAll(/\[\s*"(\w+)",\s*"SELECT/g)) keys.add(m[1]);
		expect(keys.size).toBeGreaterThanOrEqual(20);
		for (const key of ["subscribers_duplicates_merged", "visitors_linked", "profiles_app_only", "app_users_matched", "visitors_unlinked"]) expect(keys.has(key), key).toBe(true);
		for (const key of keys) expect(js, key).toMatch(new RegExp(`\\b${key}\\s*:\\s*"`));
		expect(js).toContain('subscribers_duplicates_merged: "Subscriber duplicates merged"');
		expect(js).toContain('visitors_linked: "Web visitors linked to a profile"');
	});
});

describe("visual refresh", () => {
	const pages: [string, string][] = [
		["index.html", "/"],
		["lookup.html", "/lookup"],
		["segments.html", "/segments"],
		["assistant.html", "/assistant"],
	];

	it("each page has exactly one aria-current=page, on its own nav link", () => {
		for (const [file, href] of pages) {
			const html = read(file);
			expect(html.match(/aria-current="page"/g), file).toHaveLength(1);
			expect(html, file).toContain(`<a href="${href}" aria-current="page">`);
		}
	});

	it("no HTML file has a style attribute, an inline script or a style tag", () => {
		const files = readdirSync(pub).filter((f) => f.endsWith(".html"));
		expect(files.length).toBeGreaterThanOrEqual(4);
		for (const file of files) {
			const html = read(file);
			expect(html, file).not.toMatch(/\sstyle\s*=/i);
			expect(html, file).not.toMatch(/<style\b/i);
			for (const m of html.matchAll(/<script\b[^>]*>/gi)) expect(m[0], file).toMatch(/\bsrc=/);
		}
	});

	it("the stylesheets are self-contained, declare a system-ui stack and one accent custom property", () => {
		for (const file of ["style.css", "login.css"]) {
			const css = read(file);
			expect(css, file).not.toMatch(/@import/i);
			expect(css, file).not.toMatch(/url\(\s*["']?http/i);
			expect(css, file).not.toMatch(/@font-face/i);
			expect(css, file).toMatch(/font-family:\s*system-ui/);
			expect(css, file).toMatch(/--accent:/);
		}
	});

	it("api.js table() marks numeric cells with the num class", () => {
		expect(read("api.js")).toMatch(/typeof value === "number"[\s\S]*"num"/);
	});
});
