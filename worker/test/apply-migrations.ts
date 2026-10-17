import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs before each test file, so every file starts from the real schema. Already-applied migrations are skipped.
await applyD1Migrations(env.tpo_cdp, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
