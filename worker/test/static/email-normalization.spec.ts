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

// .toLowerCase() or .trim() applied to something with "email" in its name, e.g. `email.trim()` or `row.email_raw.toLowerCase()`.
const EMAIL_CLEANUP = /email\w*(\?|!)?\s*\.\s*(trim|toLowerCase|toLocaleLowerCase|trimStart|trimEnd)\s*\(/i;
const EMAIL_CALL_CLEANUP = /(trim|toLowerCase)\s*\([^)]*email/i;

describe("email normalization", () => {
	it("no email trimming or lowercasing happens outside src/lib/email.ts", () => {
		const files = [...walk(join(root, "src")), ...walk(join(root, "scripts"))].filter(
			(f) => /\.(ts|js|mjs)$/.test(f) && relative(root, f).replaceAll("\\", "/") !== "src/lib/email.ts",
		);
		expect(files.length).toBeGreaterThan(0);
		const offenders: string[] = [];
		for (const file of files) {
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (EMAIL_CLEANUP.test(line) || EMAIL_CALL_CLEANUP.test(line)) offenders.push(`${relative(root, file)}:${i + 1}`);
				});
		}
		expect(offenders).toEqual([]);
	});

	it("the scan itself catches an email trim", () => {
		expect(EMAIL_CLEANUP.test("const e = row.email.trim();")).toBe(true);
		expect(EMAIL_CLEANUP.test("emailNorm.toLowerCase()")).toBe(true);
		expect(EMAIL_CLEANUP.test("source.trim().toLowerCase()")).toBe(false);
	});
});
