// Usage (from worker/): npm run import -- --local | --remote
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildImportStatements, renderSql } from "../src/import/build";

const target = process.argv.includes("--remote") ? "--remote" : process.argv.includes("--local") ? "--local" : null;
if (target === null) {
	console.error("Pass --local or --remote.");
	process.exit(1);
}

const dataDir = resolve(import.meta.dirname, "../../data");
const read = (name: string) => readFileSync(join(dataDir, name), "utf8");

// Report timestamps are UTC ISO-8601 without milliseconds.
const runAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const plan = buildImportStatements(
	{
		subscribersCsv: read("subscribers.csv"),
		webEventsCsv: read("web_events.csv"),
		appUsersCsv: read("app_users.csv"),
	},
	runAt,
);

const dir = mkdtempSync(join(tmpdir(), "tpo-import-"));
const file = join(dir, "import.sql");
writeFileSync(file, renderSql(plan.statements));

const wrangler = (args: string[]) =>
	spawnSync("npx", ["wrangler", ...args], { stdio: "inherit", shell: true, cwd: resolve(import.meta.dirname, "..") });

try {
	if (target === "--local") {
		// Local databases are disposable, so migrations are applied here. Remote ones are applied by hand.
		const migrated = wrangler(["d1", "migrations", "apply", "tpo-cdp", "--local"]);
		if (migrated.status !== 0) process.exit(migrated.status ?? 1);
	}
	const result = wrangler(["d1", "execute", "tpo-cdp", "--file", file, target]);
	if (result.status !== 0) process.exit(result.status ?? 1);
	console.log("Import counts from the CSV files:", plan.counts);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
