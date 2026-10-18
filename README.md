# TPO mini CDP

A mini customer data platform for The Pour Over assessment. It loads three CSV sources (newsletter subscribers, website events and app users) into one profile per person, takes signed app events over a webhook in real time, and has an AI assistant that answers questions about the audience without the model ever seeing an email, a name or a row of data.

- **Lookup:** find anyone by email, profile id, app user id or visitor id, and see their newsletter status, site visits, app activity and engagement score.
- **Segments:** filter by source, signup date, status, cold, site visits, app activity and engagement. You get a count, the top 50 profiles and charts.
- **Assistant:** ask a question in plain English ("Which pages do new subscribers hit first?") and get an answer, the plan it ran ("How I read your question"), a table and a chart. A toggle shows exactly what the AI saw.
- **Webhook:** app events (`app_open`, `read_story`, `link_click`, `login`) arrive signed and show up in lookup and segments right away, including anonymous events that a later login on the same device attaches to the right person.

## Live

- App: https://tpo-cdp.ecroatt.workers.dev (password protected; the password is shared separately)
- Webhook: `POST https://tpo-cdp.ecroatt.workers.dev/webhooks/app`. It needs an HMAC signature made with the live secret, which is not shared. To try the webhook, run the app locally with your own secret (below). The Loom shows a live send.

## How it's structured

- **Stack:** one Cloudflare Worker (TypeScript) with a D1 (SQLite) database, and static HTML plus plain JavaScript pages with Chart.js vendored in. GitHub Actions runs the tests on every PR and deploys on every push to `main`.
- **Data model:** raw rows are stored as imported (`subscribers`, `web_events`, `app_users`, `app_events`). Identity lives in link tables (`visitor_links`, `user_links`, `device_links`), and a profile is joined together at read time. `profile_id` is random, never derived from an email. One shared `normalizeEmail()` (`worker/src/lib/email.ts`) is the only place emails are cleaned.
- **Import:** `worker/scripts/import.ts` parses the CSVs, dedupes subscribers by normalized email (earliest signup wins), links web visitors and app users by email, and writes it all to D1. Running it twice creates no duplicates.
- **Webhook:** `worker/src/webhook/` verifies, validates and stores events. Who owns an anonymous event is worked out at read time by the `app_event_owner` view, so out-of-order events still land on the right person.
- **Assistant:** `worker/src/assistant/` scrubs the question, makes one model call that returns a plan, validates the plan, runs a fixed query and writes the answer from a template.

```
worker/
  src/          Worker code: routes, auth, import, segments, webhook, assistant
  public/       the UI pages (Lookup, Segments, Assistant) and vendored Chart.js
  migrations/   D1 schema
  scripts/      import, send-events (webhook simulator), perf (rows-read budget)
  test/         Vitest: workers tests (run in workerd with D1) and static source scans
data/           put the three assessment CSVs here (gitignored)
```

`SPEC.md` is the full behavior, `DECISIONS.md` the main calls and definitions, `SECURITY.md` the security model, and `AI_LOG.md` the record of AI mistakes.

## Run it locally

You need Node 24 and git. Nothing here touches a remote Cloudflare account.

1. Clone the repo and install:
   ```sh
   git clone https://github.com/ecroatt/tpo-cdp.git
   cd tpo-cdp/worker
   npm install
   ```
2. Copy the three assessment CSVs (`subscribers.csv`, `web_events.csv`, `app_users.csv`) into `data/` at the repo root.
3. Create `worker/.dev.vars` from the example and fill in your own values. The file is gitignored.
   ```sh
   cp .dev.vars.example .dev.vars
   ```
   ```
   UI_PASSWORD=<a long random password you choose>
   WEBHOOK_SECRET=<any long random string you choose>
   ANTHROPIC_API_KEY=<your Anthropic API key; only the assistant needs it>
   ```
4. Create the local database and load the CSVs. The import prints its counts.
   ```sh
   npx wrangler d1 migrations apply tpo-cdp --local
   npm run import -- --local
   ```
5. Run the tests: `npm test`.
6. Start the app: `npm run dev`, open http://localhost:8787 and sign in with your `UI_PASSWORD`.
7. In a second terminal (also in `worker/`), send a signed scenario of app events to your local webhook. Use the same `WEBHOOK_SECRET` as in `.dev.vars`:
   ```sh
   WEBHOOK_URL=http://localhost:8787/webhooks/app WEBHOOK_SECRET=<your secret> npm run send-events
   ```
   In PowerShell: `$env:WEBHOOK_URL="http://localhost:8787/webhooks/app"; $env:WEBHOOK_SECRET="<your secret>"; npm run send-events`.
   Each request prints a label and its status code. Then look up the user it names on the Lookup page. The anonymous events from before the login are now on that profile.

`npm run perf` measures D1 rows read for every UI call against the local database, and exits 1 if any call reads 25,000 rows or more.

### Deploying your own copy

Create a D1 database and put its id in `worker/wrangler.jsonc`, then:

```sh
npx wrangler secret put UI_PASSWORD
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler d1 migrations apply tpo-cdp --remote
npm run import -- --remote
npm run deploy
```

Also set a spend limit in the Anthropic Console.

## How PII is kept from the model

- **The model never sees data.** It gets one fixed system prompt (definitions, filter names and values, page list), the tool definitions, and the operator's question. It returns one tool call, the plan. The server validates the plan, runs a fixed parameterized query and writes the answer from a template. Rows, counts and ids never go to the model, so even a tricked model has nothing to leak.
- **The question is cleaned first** (`worker/src/assistant/scrub.ts`, `names.ts`):
  - Emails and ids become `[email]` and `[id]`.
  - Spelled-out or encoded emails are refused.
  - A first-and-last-name pair that matches a stored email is refused.
- **One gate:** `sendToModel()` (`worker/src/assistant/model.ts`) is the only code that calls the model or reads the API key. It scans the whole request again and refuses to send if anything looks private. Static tests fail the build if any other file calls a model.
- **You can check it:** the "What the AI saw" toggle shows the exact request body sent for every question.

What it can't catch is in `SECURITY.md` under Known issues.

## How AI was used

I planned the project and made the calls (see `DECISIONS.md`) in an interview with Claude. I wrote those calls into `SPEC.md`, which is what the code is built and tested against. Claude Code wrote the code in phases. A builder agent wrote tests first, then code, and a separate verifier agent checked each phase against the spec. Security, PII and audit agents reviewed the result before submission. Every time the AI got something wrong (caught by me, the verifier or a test), it is logged in [AI_LOG.md](AI_LOG.md) with the fix.

## What's next

- **More site pages:** add `/beliefs` and `/our-staff` to the site pages that `top_pages` leaves out by default, so they stop competing with articles.
- **Save an answer as a segment** (SPEC §7, deferred): a "Save as segment" button on `build_segment` and `engagement_ranking` answers, stored as a live definition that re-runs when opened.
- **Unfiltered queries near the read budget:** an unfiltered segment preview or `top_pages` reads about 17,000 to 22,000 rows against the 25,000-row budget, and grows with every profile and webhook event. Next: precompute scores and first pages, or cap the event window.
- **Cloudflare Access** instead of the shared password, for per-person sign-in, SSO and an audit trail.
- **From the security review** (details in `SECURITY.md` Known issues):
  - End all sessions when `UI_PASSWORD` rotates.
  - Detect names that aren't in any stored email.
  - Import through the D1 API with bound parameters instead of a rendered SQL file.
