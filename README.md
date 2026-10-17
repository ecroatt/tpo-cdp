# TPO mini CDP

A mini customer data platform on a Cloudflare Worker with D1. It merges three CSV sources (newsletter subscribers, web events, app users) into unified profiles, accepts signed app-event webhooks, and offers an AI assistant over the data that never sees emails, names, ids or results.

The behavior is specified in `SPEC.md`. Run every npm and wrangler command from `worker/`.

## Run it locally

1. Copy `worker/.dev.vars.example` to `worker/.dev.vars` and fill in `UI_PASSWORD`, `WEBHOOK_SECRET` and `ANTHROPIC_API_KEY` (the file is gitignored).
2. `npm install`, then `npx wrangler d1 migrations apply tpo-cdp --local`, then `npm run import -- --local`.
3. `npm run dev`, and sign in with your `UI_PASSWORD`.
4. `npm test` runs both Vitest projects. `npm run perf` measures D1 rows read per call against the local database and exits 1 if any call reads 25,000 rows or more.

## The assistant

`POST /api/assistant {question}` scrubs emails and ids out of the question, makes one Claude Haiku 5.5 call that must answer with one tool call, validates that plan with the shared filter validator, runs it, and writes the answer from a fixed template. The model sees only the system prompt, the tool definitions and the scrubbed question. `sendToModel()` in `worker/src/assistant/model.ts` is the only code that calls the model or reads `ANTHROPIC_API_KEY`, and it refuses to send a body that holds an email or an id. The page shows the exact request as "What the AI saw".

To deploy it, set the secret yourself: `npx wrangler secret put ANTHROPIC_API_KEY`, and set a spend limit in the Anthropic Console.

Charts use Chart.js 4.4.1, vendored in `worker/public/vendor/` so the CSP stays `script-src 'self'`.

## What's next

- Save an assistant answer as a segment (SPEC section 7): the `segments` table, `POST /api/segments`, the saved-segment list and the "Save as segment" button. This is deferred to a later run.
- Security and PII review, `SECURITY.md` and `DECISIONS.md` (SPEC phase 5).
