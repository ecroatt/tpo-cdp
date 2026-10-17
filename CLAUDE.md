# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A mini customer data platform (CDP) for a take-home assessment, due Mon Oct 19, 2026 and planned to be turned in on Sun Oct 18. It merges three CSV sources in `data/` (newsletter subscribers, web events, app users) into unified profiles, accepts signed app-event webhooks, and offers an AI assistant over the data. The brief is `docs/TPO_Developer_Assessment.pdf` (gitignored); if it conflicts with other docs, the PDF wins. The repo will be audited by an AI.

## Project rules

- Run npm and wrangler commands from `worker/`; run git from the repo root.
- All email cleanup goes through one shared `normalizeEmail()` function. Never trim or lowercase emails anywhere else.
- Only `sendToModel()` may call the AI model. The model must never receive emails, names, or raw subscriber rows.
- SQL is always parameterized with `.bind()`.
- No TODO, FIXME, or stub code. Unfinished work goes in the README's "What's next" section.
- Every feature gets tests, and `npm test` must pass before a task is done.
- Never read `.dev.vars` or print secret values.
- `SPEC.md` is the source of truth for behavior; `PLAN-NOTES.md` is background.
- Treat 2026-09-28 as "today" for anything time-based.

## Commands (from `worker/`)

- `npm test` runs Vitest once and is the CI gate. Single file: `npx vitest run test/smoke.spec.ts`; add `-t "<name>"` for one test.
- `npm run dev` starts local `wrangler dev`; `npm run deploy` deploys (CI does this on pushes to `main`).
- `npm run cf-typegen` runs `wrangler types`. Rerun it after any `wrangler.jsonc` binding change and commit the regenerated `worker-configuration.d.ts`.
- There is no lint script.

## Architecture

- Cloudflare Worker (TypeScript) with a D1 database bound as `tpo_cdp` (lowercase). Entry is `worker/src/index.ts`. The `./public` assets directory from the scaffold is still in `wrangler.jsonc`.
- The scaffold's `MyDurableObject` class was removed. `wrangler.jsonc` keeps an `exports` tombstone (`"state": "deleted"`) for it so the next deploy retires the deployed namespace and its data. `exports` and a `migrations` array cannot coexist, so do not add `migrations` back.
- Tests use `@cloudflare/vitest-plugin`, which runs them in workerd using `wrangler.jsonc`. Import `env` from `cloudflare:workers` and call `worker.fetch(request, env, ctx)` (see `test/smoke.spec.ts`).
- CI (`.github/workflows`): PRs run tests; pushes to `main` run tests, then deploy via the `production` GitHub environment. D1 migrations and `wrangler secret` values are deliberately manual.
- Planned data model is in `PLAN-NOTES.md`: raw rows are stored as imported, identity links live in separate tables (`visitor_links`, `device_links`), and profiles are joined at read time. `profile_id` is random, never derived from an email.
- Webhook `POST /webhooks/app`: HMAC-SHA256 over `timestamp + "." + rawBody`, constant-time compare, 5-minute window, bare 401 on failure, `INSERT OR IGNORE` on `event_id`.

## Secrets and Cloudflare docs

- `.claude/hooks/block-secret-files.js` blocks tools from reading secret files; `.claude/settings.local.json` is personal and gitignored.
- Check current Cloudflare docs when unsure about a Workers or D1 API.

## How phases run

- The main session is the supervisor. It sends all code writing to the `builder` subagent and all checks to the `verifier` subagent (`.claude/agents/`).
- Every gap the verifier reports is logged with `/ai-was-wrong` before it is fixed.
- At the end of a phase, print the phase report from `SPEC.md` and ask the user before pushing.
- Never start the next phase without the user's go-ahead.
