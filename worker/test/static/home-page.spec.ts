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

	it("imports renderOverview from /overview-tiles.js and calls it with the fetch response", () => {
		expect(js).toMatch(/^import\s*\{\s*renderOverview\s*\}\s*from\s*"\/overview-tiles\.js";/m);
		expect(js).toMatch(/renderOverview\(\s*tiles\s*,\s*overviewStatus\s*,\s*response\s*\)/);
	});

	it("keeps overview-tiles.js free of imports and fetch calls", () => {
		const tiles = read("overview-tiles.js");
		expect(tiles).not.toMatch(/^\s*import\b/m);
		expect(tiles).not.toMatch(/\bimport\s*\(/);
		expect(tiles).not.toMatch(/\bfetch\s*\(/);
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

	it("each stylesheet declares exactly one accent custom property, once", () => {
		for (const file of ["style.css", "login.css"]) {
			const names = [...read(file).matchAll(/(--[\w-]*accent[\w-]*)\s*:/g)].map((m) => m[1]);
			expect(names, file).toEqual(["--accent"]);
		}
	});

	describe("style.css rules", () => {
		const css = read("style.css");
		const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));

		it("marks the current nav link", () => {
			expect(rules.some((r) => /nav[^,]*\[aria-current="page"\]/.test(r.selector) && r.body.trim() !== "")).toBe(true);
		});

		it("has button hover and disabled rules", () => {
			expect(rules.some((r) => /(^|,)\s*button:hover\s*(,|$)/.test(r.selector) && r.body.trim() !== "")).toBe(true);
			expect(rules.some((r) => /button:disabled|button\[disabled\]/.test(r.selector) && r.body.trim() !== "")).toBe(true);
		});

		it("has a :focus-visible rule with an outline", () => {
			expect(rules.some((r) => /:focus-visible/.test(r.selector) && /outline:\s*\S/.test(r.body))).toBe(true);
		});

		it("has a max-width media query at or above 375px that covers the layout", () => {
			const m = css.match(/@media\s*\(max-width:\s*([\d.]+)(px|rem|em)\)\s*\{([\s\S]*)\}\s*$/);
			expect(m).not.toBeNull();
			const px = Number(m![1]) * (m![2] === "px" ? 1 : 16);
			expect(px).toBeGreaterThanOrEqual(375);
			expect(m![3]).toMatch(/\.tiles/);
			expect(m![3]).toMatch(/grid-template-columns/);
		});
	});

	describe("desktop layout and charts", () => {
		const css = read("style.css");
		const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
			selectors: m[1].split(",").map((s) => s.trim()),
			body: m[2],
		}));
		const bodiesFor = (selector: string) => rules.filter((r) => r.selectors.includes(selector)).map((r) => r.body);

		it("main max-width is exactly 72rem", () => {
			const widths = bodiesFor("main").map((b) => b.match(/max-width:\s*([\d.]+)rem/)?.[1]);
			expect(widths.filter((w) => w !== undefined).map(Number)).toEqual([72]);
		});

		it(".chart-box[hidden] and .chart-box:has(canvas[hidden]) are display: none", () => {
			for (const sel of [".chart-box[hidden]", ".chart-box:has(canvas[hidden])"]) {
				expect(bodiesFor(sel).some((b) => /(^|[;\s])display:\s*none\b/.test(b)), sel).toBe(true);
			}
		});

		it("charts.js passes type: chart.type to the Chart constructor", () => {
			const js = read("charts.js");
			expect(js).toMatch(/new window\.Chart\(\s*canvas\s*,\s*\{\s*type:\s*chart\.type\s*,/);
		});

		it("no table rule sets display: block", () => {
			for (const r of rules) {
				if (r.selectors.some((s) => /(^|\s)table$/.test(s))) expect(r.body).not.toMatch(/display:\s*block/);
			}
			expect(bodiesFor("table").some((b) => /display:\s*table/.test(b) && /width:\s*100%/.test(b))).toBe(true);
		});

		it("#results, .table-scroll and .card scroll horizontally inside themselves", () => {
			for (const sel of ["#results", ".table-scroll", ".card"]) {
				expect(bodiesFor(sel).some((b) => /overflow-x:\s*auto/.test(b)), sel).toBe(true);
			}
		});

		it("th and .num do not wrap", () => {
			expect(bodiesFor("th").some((b) => /white-space:\s*nowrap/.test(b))).toBe(true);
			expect(bodiesFor(".num").some((b) => /white-space:\s*nowrap/.test(b))).toBe(true);
		});

		it(".chart-box is framed as a card", () => {
			const body = bodiesFor(".chart-box").join(";");
			expect(body).toMatch(/background:/);
			expect(body).toMatch(/border:/);
			expect(body).toMatch(/border-radius:/);
		});

		it("charts.js caps bar width and takes its colour from --accent", () => {
			const js = read("charts.js");
			expect(js).toContain("maxBarThickness: 56");
			expect(js).toMatch(/const accent = getComputedStyle\([^)]*\)\.getPropertyValue\("--accent"\)/);
			expect(js).toMatch(/backgroundColor:\s*accent\s*,/);
			expect(js).toMatch(/borderColor:\s*accent\s*,/);
			expect([...js.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase())).toEqual(["#1f5fbf"]);
		});
	});

	it("api.js table() marks numeric cells with the num class", () => {
		expect(read("api.js")).toMatch(/typeof value === "number"[\s\S]*"num"/);
	});
});

describe("overview-tiles.js renderOverview", () => {
	const KEYS = ["people", "active_subscribers", "app_users_linked", "app_events_30d"];
	const fakeEls = () => Object.fromEntries([...KEYS, "status"].map((k) => [k, { textContent: "" }]));
	const load = async () => (await import(/* @vite-ignore */ pathToFileURL(resolve(pub, "overview-tiles.js")).href)).renderOverview;
	const tilesOf = (els: Record<string, { textContent: string }>) => Object.fromEntries(KEYS.map((k) => [k, els[k]]));

	it("shows a dash in every tile and the status line when the response is not ok", async () => {
		const renderOverview = await load();
		const els = fakeEls();
		for (const k of KEYS) els[k].textContent = "stale";
		await renderOverview(tilesOf(els), els.status, { ok: false, json: async () => ({}) });
		for (const k of KEYS) expect(els[k].textContent, k).toBe("—");
		expect(els.status.textContent).toBe("The counts could not be loaded.");
	});

	it("shows a dash in every tile when the fetch failed or the body is not JSON", async () => {
		const renderOverview = await load();
		for (const response of [null, { ok: true, json: async () => { throw new Error("bad json"); } }]) {
			const els = fakeEls();
			await renderOverview(tilesOf(els), els.status, response);
			for (const k of KEYS) expect(els[k].textContent, k).toBe("—");
			expect(els.status.textContent).toBe("The counts could not be loaded.");
		}
	});

	it("writes en-US formatted numbers and leaves the status empty on success", async () => {
		const renderOverview = await load();
		const els = fakeEls();
		const counts = { people: 12345, active_subscribers: 1234567, app_users_linked: 0, app_events_30d: 999 };
		await renderOverview(tilesOf(els), els.status, { ok: true, json: async () => counts });
		expect(els.people.textContent).toBe("12,345");
		expect(els.active_subscribers.textContent).toBe("1,234,567");
		expect(els.app_users_linked.textContent).toBe("0");
		expect(els.app_events_30d.textContent).toBe("999");
		expect(els.status.textContent).toBe("");
	});
});
