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
const sourceFiles = () => [...walk(join(root, "src")), ...walk(join(root, "scripts"))].filter((f) => /\.(ts|js|mjs)$/.test(f));

/** Returns the text of each `.prepare(` argument list, balanced through nested parens and strings. */
export function prepareArguments(text: string): { args: string; index: number }[] {
	const found: { args: string; index: number }[] = [];
	const marker = ".prepare(";
	let from = 0;
	for (;;) {
		const at = text.indexOf(marker, from);
		if (at === -1) return found;
		let depth = 1;
		let i = at + marker.length;
		let quote: string | null = null;
		for (; i < text.length && depth > 0; i++) {
			const ch = text[i];
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = null;
			} else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
			else if (ch === "(") depth++;
			else if (ch === ")") depth--;
		}
		found.push({ args: text.slice(at + marker.length, i - 1), index: at });
		from = i;
	}
}

/** Anything other than string literals joined by +, which would still be constant text. */
export function isConstantSql(rawArgs: string): boolean {
	const args = rawArgs.replace(/,\s*$/, "");
	if (args.includes("`")) return /^`[^`$]*`$/.test(args.trim());
	// Literals only, optionally joined by +.
	return /^\s*("([^"\\]|\\.)*"|'([^'\\]|\\.)*')(\s*\+\s*("([^"\\]|\\.)*"|'([^'\\]|\\.)*'))*\s*$/.test(args);
}

describe("source scans", () => {
	it("no .prepare( call is built with a template literal or + concatenation of non-constant values", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles()) {
			const text = readFileSync(file, "utf8");
			for (const { args, index } of prepareArguments(text)) {
				if (!isConstantSql(args)) offenders.push(`${rel(file)}:${text.slice(0, index).split("\n").length}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("the .prepare( scan flags dynamic SQL and accepts constant SQL", () => {
		expect(isConstantSql('"SELECT 1 " +\n "FROM t"')).toBe(true);
		expect(isConstantSql("`SELECT 1`")).toBe(true);
		expect(isConstantSql("`SELECT ${x}`")).toBe(false);
		expect(isConstantSql('"SELECT " + table')).toBe(false);
		expect(prepareArguments('db.prepare("a (b)").bind(x)').map((p) => p.args)).toEqual(['"a (b)"']);
	});

	it("no TODO or FIXME in src/ or scripts/", () => {
		const offenders = sourceFiles().filter((f) => /\b(TODO|FIXME)\b/.test(readFileSync(f, "utf8"))).map(rel);
		expect(offenders).toEqual([]);
	});

	it("no innerHTML, outerHTML, insertAdjacentHTML or document.write in public/ outside public/vendor/", () => {
		const files = walk(join(root, "public")).filter((f) => !rel(f).startsWith("public/vendor/") && /\.(js|mjs|html)$/.test(f));
		expect(files.length).toBeGreaterThan(0);
		const offenders = files.filter((f) => /innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write/.test(readFileSync(f, "utf8"))).map(rel);
		expect(offenders).toEqual([]);
	});
});
