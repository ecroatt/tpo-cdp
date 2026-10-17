import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}

const rel = (f: string) => relative(root, f).replaceAll("\\", "/");
const scanned = () => ["src", "scripts", "public"].flatMap((d) => walk(join(root, d))).filter((f) => /\.(ts|js|mjs|html|css)$/.test(f));
const MODEL_FILE = "src/assistant/model.ts";

describe("SPEC 5 model boundary", () => {
	it("only src/assistant/model.ts contains api.anthropic.com or ANTHROPIC_API_KEY (src/, scripts/, public/)", () => {
		const files = scanned();
		expect(files.length).toBeGreaterThan(10);
		const offenders = files.filter((f) => /api\.anthropic\.com|ANTHROPIC_API_KEY/.test(readFileSync(f, "utf8"))).map(rel);
		expect(offenders).toEqual([MODEL_FILE]);
	});

	it("model.ts really holds both, so the scan is meaningful", () => {
		const text = readFileSync(join(root, MODEL_FILE), "utf8");
		expect(text).toContain("api.anthropic.com");
		expect(text).toContain("ANTHROPIC_API_KEY");
		expect(text).toMatch(/export (async )?function sendToModel\(/);
	});

	it("the Anthropic header names are only in model.ts", () => {
		const offenders = scanned()
			.filter((f) => /x-api-key|anthropic-version/i.test(readFileSync(f, "utf8")))
			.map(rel);
		expect(offenders).toEqual([MODEL_FILE]);
	});

	it("sendToModel is called from exactly one place: the assistant route", () => {
		const callers = scanned()
			.filter((f) => rel(f) !== MODEL_FILE && /\bsendToModel\(/.test(readFileSync(f, "utf8")))
			.map(rel);
		expect(callers).toEqual(["src/routes/assistant.ts"]);
	});

	it("the browser code never talks to the model or holds a key", () => {
		for (const f of walk(join(root, "public")).filter((p) => !rel(p).startsWith("public/vendor/") && /\.(js|html)$/.test(p))) {
			const text = readFileSync(f, "utf8");
			expect(text, rel(f)).not.toMatch(/anthropic|x-api-key/i);
		}
	});

	it("the assistant code never imports the model SDK or reads other secrets", () => {
		for (const f of walk(join(root, "src/assistant"))) {
			const text = readFileSync(f, "utf8");
			expect(text, rel(f)).not.toMatch(/from "@anthropic-ai|WEBHOOK_SECRET|UI_PASSWORD/);
		}
	});
});
