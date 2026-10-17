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

// .toLowerCase() or .trim() applied directly to something with "email" in its name.
const EMAIL_CLEANUP = /email\w*(\?|!)?\s*\.\s*(trim|toLowerCase|toLocaleLowerCase|trimStart|trimEnd)\s*\(/i;
const EMAIL_CALL_CLEANUP = /(trim|toLowerCase)\s*\([^)]*email/i;
const CLEANING = /\.\s*(trim|toLowerCase|toLocaleLowerCase|trimStart|trimEnd)\s*\(/;

/** Names of functions in this file whose first 300 characters trim or lowercase their input. */
function cleaningHelpers(text: string): string[] {
	const names: string[] = [];
	for (const m of text.matchAll(/(?:(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(|function\s+(\w+)\s*\()/g)) {
		const body = text.slice(m.index!, m.index! + 300);
		if (CLEANING.test(body.split(/\n\s*\n|\nexport |\nconst |\nfunction /)[0] ?? body)) names.push(m[1] ?? m[2]);
	}
	return names;
}

/** Line numbers where an email-named value is trimmed or lowercased, directly or through a local helper. */
export function findEmailCleanup(text: string): number[] {
	const helpers = cleaningHelpers(text);
	const helperCall = helpers.length
		? new RegExp(String.raw`\b(?:${helpers.join("|")})\s*\([^)]*email`, "i")
		: null;
	const hits: number[] = [];
	text.split("\n").forEach((line, i) => {
		if (EMAIL_CLEANUP.test(line) || EMAIL_CALL_CLEANUP.test(line) || helperCall?.test(line)) hits.push(i + 1);
	});
	return hits;
}

describe("email normalization", () => {
	it("no email trimming or lowercasing happens outside src/lib/email.ts", () => {
		const files = [...walk(join(root, "src")), ...walk(join(root, "scripts"))].filter(
			(f) => /\.(ts|js|mjs)$/.test(f) && relative(root, f).replaceAll("\\", "/") !== "src/lib/email.ts",
		);
		expect(files.length).toBeGreaterThan(0);
		const offenders: string[] = [];
		for (const file of files) {
			for (const line of findEmailCleanup(readFileSync(file, "utf8"))) offenders.push(`${relative(root, file)}:${line}`);
		}
		expect(offenders).toEqual([]);
	});

	it("the scan itself catches direct email trims and lowercasing", () => {
		expect(findEmailCleanup("const e = row.email.trim();")).toEqual([1]);
		expect(findEmailCleanup("emailNorm.toLowerCase()")).toEqual([1]);
		expect(findEmailCleanup("source.trim().toLowerCase()")).toEqual([]);
	});

	it("the scan catches a trim wrapped in a helper, such as orNull(r.email)", () => {
		const wrapped = [
			"const orNull = (v: string | undefined): string | null => {",
			'\tconst t = (v ?? "").trim();',
			'\treturn t === "" ? null : t;',
			"};",
			"const raw = orNull(r.email);",
			"const id = orNull(r.user_id);",
		].join("\n");
		expect(findEmailCleanup(wrapped)).toEqual([5]);
		const viaFunction = "function tidy(x: string) { return x.toLowerCase(); }\nconst a = tidy(row.email_raw);";
		expect(findEmailCleanup(viaFunction)).toEqual([2]);
	});
});
