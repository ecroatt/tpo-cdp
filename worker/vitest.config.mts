import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.jsonc" },
						miniflare: {
							// Dummy secrets for tests only. The real values are never in the repo.
							bindings: {
								UI_PASSWORD: "test-ui-password",
								WEBHOOK_SECRET: "test-webhook-secret",
								ANTHROPIC_API_KEY: "test-anthropic-key",
								TEST_MIGRATIONS: migrations,
							},
						},
					}),
				],
				test: {
					name: "workers",
					include: ["test/**/*.spec.ts"],
					exclude: ["test/static/**", "node_modules/**"],
					setupFiles: ["./test/apply-migrations.ts"],
				},
			},
			{
				test: {
					name: "static",
					environment: "node",
					include: ["test/static/*.spec.ts"],
				},
			},
		],
	},
});
