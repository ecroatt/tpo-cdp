# SPEC: TPO mini CDP

This is the source of truth for behavior. The brief (`docs/TPO_Developer_Assessment.pdf`) wins on any conflict, and `PLAN-NOTES.md` is background. The decisions below were settled in the Oct 17 interview.

## 0. Shared definitions

| Term | Definition |
|---|---|
| Today | `2026-09-28`, the single constant `TODAY` in `src/lib/time.ts`. Nothing reads the wall clock for business logic. The wall clock is used only for webhook signature freshness, future-timestamp rejection and session expiry. |
| Last 30 days | Dates `>= 2026-08-29` (`TODAY` minus 30 days; 08-29 to 09-28 is the window). There is no upper bound, so live webhook events dated after `TODAY` still count. |
| Last 7 days | Dates `>= 2026-09-22`, same rule. |
| Last month | Calendar month before `TODAY`'s month: `2026-08-01` to `2026-08-31`. |
| Cold | `status = 'active'` AND (`last_open_date < 2026-08-29` OR (`last_open_date IS NULL` AND `signup_date < 2026-08-29`)). Someone who signed up in the last 30 days and hasn't opened yet is not cold. Unsubscribed people are never cold; they have already churned. |
| New subscriber | `signup_date >= 2026-08-29`. |
| Source | `normalizeSource()`: trim, lowercase, `twitter -> x`, empty -> `NULL`. One map for subscriber `acquisition_source` and web `utm_source`. |
| Email | `normalizeEmail()` in `src/lib/email.ts`: trim + lowercase, nothing else. Returns `null` for an empty value or one without exactly one `@`. It is the only place emails are trimmed or lowercased, and the import script imports the same module. |
| Timestamps | Stored as UTC ISO-8601 `YYYY-MM-DDTHH:MM:SSZ`. Web CSV timestamps have no zone and are read as UTC. Webhook timestamps must carry `Z` or an offset and are converted to UTC. |

### Test runtimes
`vitest.config.mts` defines two Vitest projects, and `npm test` (`vitest run`) runs both. Each test list below is tagged **[workers]** or **[static]**.
- **`workers`**: `@cloudflare/vitest-plugin`, with tests running inside workerd against `wrangler.jsonc` and a migrated D1. It includes `test/**/*.spec.ts` except `test/static/`. Workerd has no file system, so CSV fixtures are TypeScript modules that export strings (`test/fixtures/*.ts`), not `.csv` files.
- **`static`**: Node (`environment: "node"`), `test/static/*.spec.ts`. These are source scans that read `src/`, `scripts/` and `public/` with `node:fs`. They never import Worker code or touch D1. Run one project with `npx vitest run --project static`.

## 1. Pulls it together (import, link, dedupe)

### Data model (D1, `worker/migrations/0001_init.sql`, `0002_app_event_owner.sql`, `0003_read_indexes.sql`, `0004_device_links_user.sql`)
D1 migrations live in `migrations_dir` on the `d1_databases` entry. This is unrelated to the Durable Object `migrations` key that CLAUDE.md says must not come back.

- `profiles(profile_id TEXT PK, kind TEXT CHECK IN ('subscriber','app_only','unknown_app_user'), email_norm TEXT UNIQUE NULL, created_at TEXT)`. `profile_id` = `lower(hex(randomblob(16)))`, never derived from an email.
- `subscribers(email_norm TEXT PK, email_raw TEXT, signup_date TEXT, status TEXT, source TEXT, source_raw TEXT, last_open_date TEXT NULL)`
- `web_events(id INTEGER PK, visitor_id TEXT, page TEXT, ts TEXT, source TEXT NULL, source_raw TEXT NULL, email_raw TEXT NULL, email_norm TEXT NULL, UNIQUE(visitor_id, page, ts))`
- `visitor_links(visitor_id TEXT PK, profile_id TEXT)`
- `app_users(user_id TEXT PK, email_raw TEXT NULL, email_norm TEXT NULL, created_at TEXT NULL, origin TEXT CHECK IN ('csv','webhook'))`
- `user_links(user_id TEXT PK, profile_id TEXT)`
- `app_events(event_id TEXT PK, event TEXT, user_id TEXT NULL, device_id TEXT, ts TEXT, properties TEXT, received_at TEXT)`
- `device_links(device_id TEXT, user_id TEXT, seen_at TEXT, PRIMARY KEY(device_id, seen_at, user_id))`
- `segments`, `sessions` and `import_report` are described in their own sections.
- Indexes: `web_events(ts)`, `app_events(user_id)`, `app_events(device_id, ts)`, `subscribers(source)`, `subscribers(signup_date)`.
- Migration 0003 (read indexes, see "D1 read budget" in Known limitations) adds `visitor_links(profile_id, visitor_id)`, `user_links(profile_id, user_id)`, `web_events(visitor_id, ts)` (replaces `web_events(visitor_id)`) and `app_events(ts)`.
- Migration 0004 (see "D1 read budget") adds `device_links(user_id, device_id)` and replaces `app_events(ts)` with the covering `app_events(ts, user_id, event, device_id)`.

### Import (`npm run import -- --local|--remote`)
- `scripts/import.ts` (run with `tsx`) reads the three CSVs from `../data/`, builds parameter-safe SQL with the pure functions in `src/import/`, writes it to a temp file, and runs `wrangler d1 execute tpo-cdp --file <tmp> --local|--remote`.
- Pure functions (`parseCsv`, `buildImportStatements`) hold all the rules, so tests run them without the CSVs.
- **Subscribers:** skip fully blank rows. Rows with an invalid email are skipped and counted. Group by `normalizeEmail(email)`, then keep one row per email: earliest `signup_date`, with `last_open_date` = max across the group. Status, source and last open are taken from the kept row; in the real data the duplicate pairs agree on every field. Insert with `INSERT OR IGNORE`.
- **Profiles:** one `subscriber` profile per subscriber email. App users whose email matches no subscriber get one `app_only` profile each. Profiles are created with `INSERT INTO profiles SELECT … WHERE NOT EXISTS (… email_norm = ?)`, so a re-run never mints a second ID.
- **Web events:** `INSERT OR IGNORE` on `UNIQUE(visitor_id, page, ts)`. `visitor_links`: every visitor_id with at least one visit carrying an email maps to the profile for that normalized email, and all of that visitor's visits attach, including visits with no email. A visitor whose email matches no profile stays unlinked and is counted (0 in the real data). If a visitor ever has two different emails, the earliest visit's email wins and the case is counted (0 in the real data).
- **App users:** `user_links` maps user_id to the profile with the same `email_norm`.
- **Import report:** `import_report(run_at, metric, value)` gets one row per metric on each run: rows read per file, blank rows, invalid emails, subscriber duplicates merged, profiles by kind, visitors linked/unlinked, visits linked, app users matched/app-only. `GET /api/import-report` returns the latest run, and the UI header shows it.
- **Read-time linking:** raw rows keep their own columns and identity lives only in the link tables. Every profile query joins through `visitor_links`, `user_links` and the `app_event_owner` view (§4).

**Expected on the real data:** 2,987 subscribers read (2,995 minus 8 blank), 85 merged, 30 `app_only` profiles, 900 app users matched, about 8,400 visits linked.

### Tests
**[workers]** `test/import.spec.ts`, with synthetic fixtures in `test/fixtures/`:
- `normalizeEmail`: trims, lowercases, keeps Gmail dots and `+tags`, returns null for blank or no-`@` input.
- Subscribers `" A@x.com"` and `"a@x.com "` merge into one row and the report counts 1 merge.
- Blank rows are skipped and counted.
- A web visit with email `"  B@X.com"` links its visitor, and that visitor's email-less visits attach to the same profile.
- An app user matching a subscriber shares that subscriber's profile; an unmatched app user gets an `app_only` profile.
- Running the import twice gives identical row counts and identical `profile_id`s.
- `normalizeSource` maps `twitter -> x`, `Instagram -> instagram` and empty -> null.

**[static]** `test/static/email-normalization.spec.ts`:
- No email trimming or lowercasing happens outside `src/lib/email.ts`. The scan reads `src/` and `scripts/` for `.toLowerCase()` or `.trim()` applied to email-named variables.

## 2. Finds anyone (lookup)

- `POST /api/lookup {q}` (JSON body, so the searched value never appears in a URL or a request log; it passes the §8 CSRF check like every state-changing `/api` call) uses exact matching only and no partial search. There is no `GET /api/lookup`. Matching order:
  1. Contains `@`: `normalizeEmail(q)` matched against `profiles.email_norm`.
  2. Then `q` is tried as a `profile_id`, a `user_id` (via `user_links`) and a `visitor_id`.
- **Response for a profile:**
  - `profile_id`, `kind` and email.
  - **Newsletter:** signup date, status, source, last open, cold flag, days since open.
  - **App accounts:** user_ids and created dates.
  - **Site visits:** linked visitor_ids, total count, and the 100 most recent, sorted by `ts` desc.
  - **App activity:** total count and the 100 most recent, sorted by event `ts` desc. Each event is flagged `attributed_from_device: true` when it was anonymous and attached through `device_links`.
  - **Engagement score**, with its breakdown (§3).
- A visitor_id that isn't linked returns `{ kind: "anonymous_visitor", visits }`. If nothing matches, the response is 404 `{ "error": "not_found" }`.
- New webhook events appear on the next request because nothing is cached.
- **UI:** one search box, with newsletter, site visits and app activity cards on one screen.

### Tests
**[workers]** `test/lookup.spec.ts`:
- An email with different case and spaces finds the profile.
- Lookup by user_id, profile_id and visitor_id each return the same profile.
- A partial email returns 404.
- The profile shows visits from an email-less visit on a linked visitor.
- A webhook event posted in the test shows up in a lookup made right after it.
- An anonymous event attributed by login is flagged.
- An unauthenticated request returns 401.

## 3. Builds a segment

### Filters (`src/segments/filters.ts`)
One validated filter object is shared by the Segments page, the assistant tools and saved segments:

| Filter | Type | SQL meaning |
|---|---|---|
| `sources` | string[] from the source map | `subscribers.source IN (…)` |
| `status` | `active` \| `unsubscribed` | equality |
| `signup_from`, `signup_to` | `YYYY-MM-DD` | inclusive range |
| `cold` | boolean | Cold definition (§0) or its negation |
| `not_opened_days` | int 1–365 | literal "haven't opened in N days": `last_open < TODAY-N` or never opened with `signup < TODAY-N` |
| `kind` | profile kind[] | `profiles.kind IN (…)` |
| `has_app` | boolean | profile has at least one `user_links` row |
| `app_active_days` | int 1–365 | has an owned app event with `ts >= TODAY-N` |
| `min_site_visits` | int 0–10000 | linked visits in the last 30 days `>=` N |

- The validator rejects unknown keys and out-of-range values. `buildWhere(filters)` returns `{ sql, binds }` from fixed fragments only, and every value goes through `.bind()`.
- **Engagement score** (`src/segments/engagement.ts`), counted over the last 30 days:
  - Newsletter: 3 points if the last open was in the last 7 days, otherwise 1 point if it was in the last 30 days.
  - Site: 1 point per linked site visit.
  - App: 2 points per `read_story`, and 1 point per other owned app event (`app_open`, `link_click`, `login`).
  - The weights are documented in README and DECISIONS.md.

### API and UI
- `POST /api/segments/preview {filters}` returns the count, the first 50 rows (profile_id, email, source, status, signup, last open, score) and a chart dataset (count by source and by status).
- `GET /api/segments/preview.csv` is out of scope.
- **UI:** a filter form, the count, a table and Chart.js bar charts. Saving a segment (§7) is deferred to the README's "What's next".
- The brief's example "signed up from Instagram and haven't opened in 30 days" is `{sources:["instagram"], not_opened_days:30}`.

### Tests
**[workers]** `test/segments.spec.ts`:
- The brief's example returns exactly the expected fixture profiles.
- Cold boundary cases:
  - Last open on 08-28 is cold; last open on 08-29 is not.
  - Never opened with signup 08-28 is cold; never opened with signup 08-29 is not.
  - An unsubscribed subscriber is never cold.
- `twitter` web traffic and `X` subscribers both match `sources:["x"]`.
- An unknown filter key gets a 400, and so does `not_opened_days: -1`.
- A SQL-injection-looking source value is rejected by the validator and never reaches SQL.
- The engagement score matches a hand-computed fixture.
- A webhook `read_story` changes the score and `app_active_days` membership with no restart.

## 4. Never sleeps (`POST /webhooks/app`)

### Request handling order
1. Anything except `POST` gets 405.
2. **Rate limit:** the Workers Rate Limiting binding `WEBHOOK_LIMITER` allows 120 requests per 60 s, keyed on `CF-Connecting-IP` (or `"unknown"` if the header is missing). Over the limit gets 429. The handler reads the limiter through a `Limiter` interface (`{ limit({key}): Promise<{success}> }`), so tests can pass a fake.
3. **Size:** reject with 413 if `Content-Length` is over 16 KB, or if the body read so far passes 16 KB.
4. **Auth** (`src/webhook/verify.ts`):
   - Headers: `X-TPO-Timestamp` (unix seconds) and `X-TPO-Signature` (hex HMAC-SHA256 with `WEBHOOK_SECRET` over `timestamp + "." + rawBody`).
   - The request is rejected if a header is missing, the timestamp is more than 300 s off the wall clock in either direction, or the signature doesn't match.
   - The comparison is constant-time (`crypto.subtle.timingSafeEqual` on equal-length buffers) and runs on the raw bytes before JSON parsing.
   - Any failure returns a bare `401` with an empty body.
5. A `Content-Type` other than `application/json` gets 415.
6. **Validation** (strict). Failures return 400 `{ "error": "invalid_event" }` and nothing is stored.
   - `event_id`: string, 1–64 chars, `[A-Za-z0-9_-]`.
   - `event` must be one of `app_open | read_story | link_click | login`.
   - `device_id`: string, 1–64 chars, same charset.
   - `user_id`: either null or a string with the same charset.
   - `timestamp`: ISO-8601 with a zone, and no more than 5 minutes after the wall clock.
   - `properties`: an object (default `{}`).
   - `read_story` requires a `properties.story` slug (`[a-z0-9-]{1,120}`). `link_click` requires `properties.url`, an `http(s)` URL of at most 2048 chars.
   - `login` requires a non-null `user_id`.
   - Unknown top-level keys are rejected.
7. **Store**, in one `env.tpo_cdp.batch([...])`, which runs as a transaction:
   - `INSERT OR IGNORE INTO app_events`.
   - If `user_id` is set, also `INSERT OR IGNORE INTO device_links(device_id, user_id, ts)`.
   - **Unknown user_id:** `INSERT OR IGNORE INTO app_users (origin 'webhook', no email)`. Then a `profiles` insert guarded by `WHERE NOT EXISTS (SELECT 1 FROM user_links WHERE user_id = ?)`, creating an `unknown_app_user` profile. Then `INSERT OR IGNORE INTO user_links`.
8. **Response:** `200 {"status":"stored"}` or `200 {"status":"duplicate"}` (first write wins; a duplicate's payload is ignored even if it differs).

### Out of order and login stitching
- Events are stored with their own `timestamp`. Every read sorts by event `ts`, and "last seen" = `MAX(ts)`.
- The `app_event_owner` view resolves who owns each event at read time:
  - An event with a `user_id` belongs to that user.
  - An anonymous event on device D belongs to the user of the latest `device_links` row on D with `seen_at <= event.ts`.
  - If there's no such row, it belongs to the user of the earliest row after the event.
  - If D has no rows at all, the event stays unowned. It's stored and counted in the stats, but belongs to no profile.
- This covers shared devices (user A logs in, then user B) and anonymous events that arrive after the login.

### Simulator (`npm run send-events`)
- `scripts/send-events.ts` reads `WEBHOOK_URL` and `WEBHOOK_SECRET` from the environment and signs with the same `sign()` used by the tests.
- It sends a realistic scenario:
  - anonymous app_open and read_story events
  - a login
  - later events
  - a duplicate
  - an out-of-order event
  - an unknown user
  - a second user logging in on the same device
- It prints status codes only.

### Tests
**[workers]** `test/webhook.spec.ts`

**Auth and limits**
- A valid signature gets 200 stored.
- A bad signature gets 401 with an empty body.
- A missing header gets 401.
- A timestamp 301 s old gets 401.
- A body changed after signing gets 401.
- A non-JSON content type gets 415.
- A 17 KB body gets 413.
- **Rate limit, with a fake limiter.** The test passes a fake `Limiter` that returns `{success:false}`, and checks two things:
  - The response is 429, and the fake saw the caller's `CF-Connecting-IP` as the key.
  - The 429 arrives before signature checking: a 429 is returned even with a bad signature.
- **Rate limit, real binding.** One request through the real `WEBHOOK_LIMITER` with a unique IP gets 200, which proves the binding is wired.

  Miniflare does enforce the binding under the vitest plugin; this was checked Oct 17 with limit 3, which gave 200, 200, 200, 429. Its counters still aren't safe to test against directly, for two reasons:
  - **Shared state:** the counters persist across tests in a run.
  - **Clock-aligned window:** the 60 s window resets on the wall-clock minute, so a 121-request test could flake when it crosses a minute boundary.

  Every webhook test therefore sets its own `CF-Connecting-IP`, and the 429 path is proven with the fake.
- GET gets 405.

**Validation**
- A bad event type gets 400 and nothing is stored.
- `read_story` without a story gets 400.
- A timestamp 10 minutes in the future gets 400.
- `login` with a null user gets 400.

**Storage and attribution**
- A duplicate `event_id` gets 200 duplicate, and the row count stays 1.
- For out-of-order events (newer sent first), lookup lists them by event time and last seen = max.
- Anonymous events, then a login, then a lookup: the earlier events are attached and flagged.
- When the anonymous event is sent after the login but is dated before it, it is still attached.
- For a device that logs in as A and then B, each anonymous event goes to the right user by time.
- An unknown user_id creates an `unknown_app_user` profile visible in lookup. Sending a second event for that user creates no second profile.

## 5. Talks back (AI assistant, no PII to the model)

### Flow (`POST /api/assistant {question}`)
1. **Scrub the question** (`src/assistant/scrub.ts`):
   - Email patterns are replaced with `[email]`.
   - ID patterns (`u_…`, `d_…`, `v_…`, 32-hex profile_ids) are replaced with `[id]`. The `u_/d_/v_` pattern also takes `_` and `-` after the prefix (`d_sim_abc_phone`) and needs no word boundary before it (`x_u_2b6447a3`).
   - Before matching, the question is NFKC-normalized (so a fullwidth `＠` becomes `@`) and every format or default-ignorable character (Unicode `Cf` and `Default_Ignorable_Code_Point`, which covers zero-width characters and the soft hyphen) is removed. The email pattern takes Unicode letters and digits, so `jöhn@example.com` is replaced whole.
   - **Blocked, not scrubbed:** a question that still looks like it holds an email gets 422 `{ "error": "blocked_pii" }` and no model call: spaces around `@` (`jane @ gmail.com`), `%40`, `&#64;` or `&#x40;` (with or without the `;`), a typed backslash escape `\u0040`, a spelled-out address (`jane at gmail dot com`, `jane at gmail.com`, and `at`/`dot` in `()`, `[]`, `{}` or `<>`). The same check runs inside `sendToModel` on the whole body.
   - **Name check:** a question in which two adjacent words are the first and last name from a stored email's local part gets 422 `{ "error": "blocked_pii" }` and no model call. Words are the runs of letters in the lowercased question. For each adjacent pair `a b`, the check looks for a `profiles.email_norm` that starts with `a.b`, `a_b` or `ab` followed directly by a digit or `@` (an indexed range on `profiles.email_norm`, so it reads only the matching rows, in statements that stay under D1's 100 bound parameters). So "is Julia Evans active?" is blocked when `julia.evans230@…` is stored. Names that are in no stored email, and single first names, cannot be detected (SECURITY.md known issues).
   - The UI tells the user that individual lookups belong on the Lookup page, and shows a plain message for `blocked_pii`.
   - **Rate limit:** `ASSISTANT_LIMITER`, 20 per 60 s per IP, returns 429 `{ "error": "rate_limited" }` with `Retry-After: 60` before the scrub, the name check or any model call.
2. **One-shot plan.** There is exactly one model call per question, to Claude Haiku 5.5 (`claude-haiku-5-5`) through the Anthropic Messages API:
   - Settings: `max_tokens` 512, and no `temperature`, `top_p` or `top_k` (Claude Haiku 5.5 rejects any non-default sampling parameter with a 400). The forced tool call and the fixed answer templates keep the output deterministic in shape.
   - The request uses `tools` with `tool_choice: {type: "any"}`, so the model must reply with exactly one tool call, which is the plan `{tool, params}`. Any text it adds alongside the call is ignored.
   - **System prompt:** the role, `TODAY` and the shared definitions from §0, the allowed filter keys and values, the profile kinds, the page list, and the event types. It contains no rows.
   - The server validates the plan, runs it, and builds the answer sentence from a fixed template for each tool, e.g. "312 profiles match: Instagram, signed up 2026-08-01 to 2026-08-31, cold." The model never sees results, so it never writes the answer.
3. **Tools** (`src/assistant/tools.ts`). The model never writes SQL. Every plan is checked by the §3 validator; an invalid plan returns 422 `{ "error": "unsupported_question" }` and no SQL runs.
   - `count_profiles(filters)` returns a count.
   - `build_segment(filters)` returns a count, rows and a by-source chart.
   - `top_pages(filters, mode: "all" | "first_visit", limit ≤ 20, include_site_pages = false)` returns `[{page, profiles}]`. `first_visit` is the earliest visit per profile across all of that profile's linked visitor_ids, at any time (it usually comes before signup, so it shows what brought them in).
     - **Site pages** are `/`, `/subscribe` and `/about`, defined once as the `SITE_PAGES` constant in `src/assistant/tools.ts`. Every other page is a content page, including `/beliefs`, `/our-staff` and `/shadrachs-picks`. Matching is exact, never by prefix.
     - By default (`include_site_pages: false`) visits to site pages are dropped before counting, in both modes. In `first_visit` that makes the result each profile's first content page; a profile with only site-page visits is not counted.
     - The plan always carries `include_site_pages`; the validator fills in `false` when it is missing and rejects any non-boolean. The prompt tells the model to set it to `true` only when the question asks about those pages (the home page, the subscribe page or the about page).
     - When site pages are left out, the answer text ends with "Leaves out site pages: /, /subscribe, /about.", built from `SITE_PAGES`, including when no pages are found. With `include_site_pages: true` it has no such sentence.
   - `breakdown(by: "source" | "status" | "signup_month" | "kind" | "cold", filters)` returns `[{group, count}]`.
   - `engagement_ranking(limit ≤ 100, filters)` returns ranked rows with scores.
   - `unsupported(reason)` covers questions no tool fits. The UI shows the reason and suggests the Segments page.
4. **What the model sees:** only the system prompt, the tool definitions and the scrubbed question. It never receives query results of any kind, so no profile_ids, emails, user/visitor/device IDs, raw rows or even counts.
5. **Response to the browser:**
   - `{ answer, plan, result: {tool, params, rows?, chart?}, model_request }`.
   - `rows` (with emails) come straight from the DB and never pass through the model.
   - `plan` is shown in the UI as "How I read your question", so the user can check the interpretation.
   - `model_request` is the exact JSON body sent to the model, for the "What the AI saw" toggle.
6. **`sendToModel(body, deps)`** (`src/assistant/model.ts`) is the only code that calls the model or reads `ANTHROPIC_API_KEY`.
   - Before sending, it serializes the whole body and scans it for an email regex and the ID patterns.
   - On a hit it throws `PiiBlockedError` with no network call, and the API returns 422 `{ "error": "blocked_pii" }`.
   - Model errors and timeouts (20 s) return 502 `{ "error": "assistant_unavailable" }`.
   - `deps.fetch` defaults to the global `fetch`; tests pass their own.

### Must answer the brief's examples
| Question | Expected tool call |
|---|---|
| "How many Instagram signups went cold last month?" | `count_profiles({sources:["instagram"], signup_from:"2026-08-01", signup_to:"2026-08-31", cold:true})` |
| "Build me a list of our most engaged readers" | `engagement_ranking({limit:50})`, with the table shown in the UI |
| "Which pages do new subscribers hit first?" | `top_pages({signup_from:"2026-08-29"}, "first_visit")`, with a chart |

### Tests
**[workers]** `test/assistant.spec.ts`. The model is replaced by a scripted fake `fetch` that returns a fixed tool_use plan.
- `sendToModel` throws `PiiBlockedError` and makes no fetch call when an email is anywhere in the body (system prompt or message), and likewise for a `v_…` ID.
- `scrub` replaces `Jane.Doe+x@Gmail.com` and `u_2b6447a3`, and also `d_sim_abc_phone`, `x_u_2b6447a3` and `jane＠gmail.com` (fullwidth).
- Each of `jane @ gmail.com`, `jane at gmail dot com`, `jane(at)gmail(dot)com`, `jane%40gmail.com`, `jane&#64;gmail.com`, `jane\u0040gmail.com` (a typed backslash escape) gets 422 `blocked_pii` with no fetch call, and `sendToModel` throws `PiiBlockedError` for each when it is in the body. A plain email hidden with a zero-width character or soft hyphen (`ja​ne@gmail.com`) is scrubbed to `[email]` like any plain email, and `sendToModel` blocks it if it reaches the body unscrubbed.
- With a profile whose email is `julia.evans230@example.com`, "is Julia Evans active?" and "how engaged is julia evans" get 422 `blocked_pii` with no fetch call. "how many instagram signups are cold?" is not blocked and makes one fetch call. The name check reads at most 6 rows per adjacent word pair (at most 10 for a two-word question) for a question with no names on the `test/rows-read.spec.ts` seed, however many profiles there are.
- Over the limit, a fake `ASSISTANT_LIMITER` makes the route return 429 with no fetch call.
- A question that includes an email makes exactly one fetch call. The captured body contains no seeded email, profile_id, user_id or result count, and the browser response still contains the rows with emails.
- Each of the three example questions, given the expected scripted plan, returns the correct count or pages against fixtures, with the templated answer.
- `first_visit` picks a visit before signup when one exists, across two linked visitor_ids.
- `top_pages` with the brief's Q1 filters (Instagram, signed up 2026-08-01 to 2026-08-31, cold), in both modes, returns no `/`, `/subscribe` or `/about` rows, still counts `/shadrachs-picks`, and names the left-out pages in the answer. The same plan with `include_site_pages: true` brings the site pages back, with hand-derived counts.
- `validatePlan` fills `include_site_pages: false` by default and rejects a non-boolean value.
- `npm run perf` and `test/rows-read.spec.ts` cover `top_pages` in both modes with both values of `include_site_pages`, each under the rows-read budget.
- An invalid plan (unknown filter) returns 422 and runs no SQL.
- An `unsupported` plan returns its reason and runs no SQL.

**[static]** `test/static/model-boundary.spec.ts`:
- Only `src/assistant/model.ts` contains `api.anthropic.com` or `ANTHROPIC_API_KEY`.
- No file in `src/` or `scripts/` uses another model path: `env.AI`, a Workers AI `.run("@cf/…")`, `gateway.ai.cloudflare.com`, `api.openai.com`, `generativelanguage.googleapis.com`, or an `Authorization: Bearer` header. `wrangler.jsonc` has no `ai` binding.

## 6. Extra: chart answers
- Charts come from data, never from the model's prose. Charts are built server-side as `{type, labels, values, title}`:
  - `breakdown` and `top_pages` always get one.
  - `build_segment` gets one by source.
- **Chart type:** `type` is `"line"` when the labels are dates or months, and `"bar"` otherwise. A label is a date or month when it matches `YYYY-MM-DD` or `YYYY-MM`. The labels count as dates when there is at least one such label and every other label is `none` (the "no newsletter row" group, kept as the last point so no profile drops out of the chart). So `breakdown` by `signup_month` (signups by month) is a line; by source, status, kind or cold, `top_pages` and `build_segment` are bars, and a chart with no labels is a bar. The type is picked by one function, `chartType(labels)`, from the labels alone, never by the model.
- The UI renders the chart above the table with Chart.js, drawing `chart.type` as given. The Segments page uses the same chart helper (its by-source and by-status charts are bars).
- The UI is static HTML and plain JavaScript in `public/` (one ES module per page plus a shared `api.js`), with no framework and no build step. Chart.js is the only library, vendored in `public/vendor/` at a pinned version, so the CSP stays `script-src 'self'`.
- **Tests [workers]** `test/charts.spec.ts`: a `breakdown` result has chart labels and values equal to the DB counts, and `count_profiles` has no chart. `breakdown` by `signup_month` has `type: "line"` (with `none` last), every other chart has `type: "bar"`, and `chartType` returns `"line"` for month labels, day labels, and month labels plus `none`, and `"bar"` for no labels, only `none`, page paths, source names, and a mix of months and other text.

## 7. Extra: save answer as segment (deferred, not built)

Deferred under the Phase 4 cutoff so the security audit and docs got the time (DECISIONS.md). Nothing below exists in the code; it is the design for the README's "What's next".

- `segments(segment_id TEXT PK random, name TEXT, definition TEXT JSON, origin TEXT CHECK IN ('builder','assistant'), created_at TEXT)`.
- `definition` = `{tool: "build_segment" | "engagement_ranking", params}`. It is stored live: opening a segment re-runs it, so webhook events change its membership. It never stores a list of people.
- Any assistant result from `build_segment` or `engagement_ranking` gets a **Save as segment** button that sends `POST /api/segments {name, definition}`. The server re-validates the definition and rejects other tools.
- `GET /api/segments` lists saved segments with live counts. `GET /api/segments/:id` re-runs one. `DELETE /api/segments/:id` deletes one.
- **Tests [workers]** `test/saved-segments.spec.ts`:
  - A saved definition round-trips.
  - A new matching webhook event raises the saved segment's count.
  - Saving a `top_pages` result gets 400, and so does an invalid filter.
  - `name` is capped at 80 chars and rendered as text, not HTML.

## 8. Security

### UI password
- `GET /login` serves the form. `POST /login` takes a form field `password`.
- **Login rate limit:** `LOGIN_LIMITER`, 10 per 60 s per IP, returns 429 with `Retry-After: 60` and the login page (HTML) saying "Too many attempts. Wait a minute and try again."
- **Body size:** `POST /login` gets 413 when its body is over 4 KB, and a JSON `/api` POST gets 413 `{ "error": "payload_too_large" }` when its body is over 8 KB, checked from `Content-Length` and while reading, before the body is parsed.
- **Compare:** the password is checked against `UI_PASSWORD` in constant time: HMAC both values with a per-request key, then `timingSafeEqual`.
- **Session:**
  - On success, 32 random bytes are generated and the SHA-256 of the token is stored in `sessions(token_hash PK, created_at, expires_at)`, which expires after 12 h.
  - The cookie is `__Host-session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`.
  - Expired rows are deleted on each login.
- **Logout:** `POST /logout` deletes the row and clears the cookie.
- **Gate:**
  - `assets.run_worker_first: true`, so the Worker checks every request before static files are served.
  - Only `/login`, `/login.css` and `/webhooks/app` are public.
  - Without a valid session, pages redirect 302 to `/login` and `/api/*` returns 401.
- **CSRF:** a state-changing `/api` request must have `Content-Type: application/json` and an `Origin` equal to the request's own origin, or it gets 403. The `SameSite=Strict` cookie adds a second layer.
- **Production:** Cloudflare Access replaces this (SECURITY.md, README).

### Webhook auth
- As in §4. The live `WEBHOOK_SECRET` is never shared. Reviewers set their own in `.dev.vars` and use `npm run send-events` locally, and the Loom shows a live send.

### Secrets and hardening
- **Secrets:** `UI_PASSWORD`, `WEBHOOK_SECRET` and `ANTHROPIC_API_KEY` are set with `wrangler secret put`.
  - Local: `.dev.vars` (gitignored), with `.dev.vars.example` listing the names only.
  - Tests: dummy values in `vitest.config.mts` miniflare bindings.
  - A spend limit is set in the Anthropic Console.
- **Headers on every response:**
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Strict-Transport-Security: max-age=31536000`
  - `Cache-Control: no-store` on every response except the public `/login.css` (pages, `/api/*`, scripts and `/login` included)
- **Errors and logs:** errors return generic JSON (`{"error":"internal"}`) with no stack traces. Logs record route, status and error class only, never emails, bodies or question text.
- **SQL:** every query uses `.bind()`. The only dynamic SQL is fixed fragments chosen by the validator.
- **Rendering:** the UI writes all data with `textContent` or `createElement`, never `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`.

### Tests
**[workers]** `test/security.spec.ts`

**Login and session**
- A wrong password gets 401 and no cookie.
- The right password sets a cookie with `HttpOnly`, `Secure`, `SameSite=Strict` and the `__Host-` prefix.
- `/api/import-report` works with the cookie and returns 401 without it.
- `/` without a session redirects to `/login`.
- An expired session gets 401.
- After logout the old token gets 401.
- Too many logins get 429 with `Retry-After: 60` and an HTML login page, using a fake `Limiter` for `LOGIN_LIMITER` as in §4.
- A 5 KB `POST /login` body and a 9 KB `/api/assistant` body each get 413.
- `Cache-Control: no-store` is on a signed-in page (`/`) and on `/login`, and not on `/login.css`.
- **[workers]** `test/lookup.spec.ts` ("lookup is POST only"): `POST /api/lookup` with a foreign `Origin` gets 403, and `GET /api/lookup?q=…` does not run a lookup.

**Requests and headers**
- A POST to `/api/segments` with a foreign `Origin` gets 403.
- The CSP and nosniff headers are present on HTML and API responses.
- A 500 response body contains no stack trace.

**[static]** `test/static/source-scans.spec.ts`
- No `.prepare(` call is built with a template literal or `+` concatenation of non-constant values (a source scan that allows only the filter-fragment builder).
- No `TODO` or `FIXME` in `src/` or `scripts/`.
- No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in `public/` outside `public/vendor/`.

## Phases

Each phase runs autonomously under `/goal`. A Sonnet builder subagent writes the code and tests, and an Opus verifier subagent checks the phase against the SPEC sections listed. Phases run in order and a phase starts only when the previous one is done.

### Done condition (every phase)
The transcript must show all five:
1. Each test file listed for the phase exists and passes. Each listed test is named in the Vitest output.
2. `npm test` (both projects) exits 0.
3. The verifier's final message reads "no gaps". It has checked every bullet of the listed SPEC sections against the code and tests, and checked that nothing in the phase breaks a project rule in CLAUDE.md. Any gap it reports is fixed and re-verified first.
4. The work is committed in small commits and pushed to `main`, and the CI run for the last commit succeeded (`gh run list --limit 1`).
5. The phase's live check passes against the deployed URL.

### Phase report (end of every phase)
- **What was built:** files and routes, mapped to SPEC sections.
- **Check on the live site:** 3 things you can click or curl, each with the expected result.
- **What the verifier caught:** each gap and how it was fixed, or "nothing".
- **How it works:** 5 bullets, written to be explained in the Loom.

### Phase 1: Foundation, auth, first deploy (10:15–12:00, 1:45)
- **Scope:**
  - The two Vitest projects (§0 Test runtimes).
  - §0 definitions (`TODAY`, `normalizeEmail`, `normalizeSource`).
  - §1: migrations, the import script, the import report and `/api/import-report`.
  - §8 UI password: login, sessions, the gate with `run_worker_first`, CSRF helper, headers, generic errors.
  - A placeholder home page behind the gate, listing the import report.
- **Your manual steps** (the builder stops and prints the exact commands, and never sees the values):
  - `wrangler secret put UI_PASSWORD` and `wrangler secret put WEBHOOK_SECRET`.
  - `.dev.vars` for local runs.
  - `wrangler d1 migrations apply tpo-cdp --remote` and `npm run import -- --remote`. CLAUDE.md keeps remote migrations manual.
- **Tests:**
  - [workers] `test/import.spec.ts`
  - [workers] `test/security.spec.ts` (login/session, gate and header cases; the CSRF case lands in Phase 2)
  - [static] `test/static/email-normalization.spec.ts`
  - [static] `test/static/source-scans.spec.ts`
- **Live check:**
  - `GET /` without a cookie returns 302 to `/login`.
  - `/login` returns 200 with the CSP header.
  - A read-only `wrangler d1 execute tpo-cdp --remote --command "SELECT metric, value FROM import_report …"` shows the expected counts from §1.

### Phase 2: Lookup and segments (12:00–13:30, 1:30)
- **Scope:**
  - §2 lookup API and page.
  - §3 filters, `buildWhere`, engagement score, `POST /api/segments/preview`, and the Segments page (form, count, table; the chart is drawn in Phase 4).
  - The §8 CSRF test.
- **Tests:**
  - [workers] `test/lookup.spec.ts` and `test/segments.spec.ts`, except the cases that need the webhook, which are added in Phase 3.
  - [workers] the CSRF case in `test/security.spec.ts`.
  - [workers] `test/rows-read.spec.ts`: seeds 1,500 profiles with visitors, web events and 300 app users, then asserts lookup by email and both segment previews each read at most 4 times the seeded rows (linear), using the pure recorder in `scripts/lib/rows-read.ts`.
  - [workers] `test/rows-read.spec.ts` also gives lookup its own budget, 10 x the rows the looked-up profile owns plus 30, which fails if `visitor_links(profile_id)` or `user_links(profile_id)` loses its index.
  - [workers] `test/segments.spec.ts` ("preview ordering done in JS"): score ties break by `profile_id` ascending, chart groups sort by count descending then name (including `none`), and with more than 50 matches the 50 returned are the highest scorers while `count` stays the full total.
- **Live check:**
  - Look up a known subscriber by an email with different case and spaces; the profile shows site visits.
  - The brief's Instagram/30-day segment returns a count.

### Phase 3: Webhook and simulator (13:30–14:45, 1:15)
- **Scope:**
  - §4 in full: `Limiter` interface, `WEBHOOK_LIMITER` binding (rerun `npm run cf-typegen`), verify, validate, store, the `app_event_owner` view.
  - `scripts/send-events.ts`.
  - The webhook cases of §2 and §3 (an event appears in lookup, an anonymous event is flagged, a `read_story` changes the score and segment membership).
  - The `app_event_owner` view, and every query that reads it (lookup app activity, engagement, score, `app_active_days`), must meet the same D1 read budget as Phase 2 (see Known limitations), checked by `npm run perf` with webhook events loaded. The view computes `owner_user_id` per event, so `o.owner_user_id = ul.user_id` cannot use an index; keep those queries proportional to the events in the window, not to profiles x events.
- **Tests:**
  - [workers] `test/webhook.spec.ts`.
  - [workers] the webhook cases added to `test/lookup.spec.ts` and `test/segments.spec.ts`.
  - `npm run send-events` against local `wrangler dev` prints the expected status codes.
- **Live check:**
  - An unsigned `POST /webhooks/app` returns a bare 401.
  - You run `npm run send-events` against the live URL with the live secret. The builder never handles that secret.
  - The anonymous-then-login device then shows its events in live lookup.

### Phase 4: Assistant and extras (14:45–16:15, 1:30; cutoff 4:45 pm)
- **Scope:**
  - §5 assistant (scrub, plan call, tools, templates, `sendToModel`) and its page with the "What the AI saw" toggle.
  - §6 charts (assistant and Segments page).
  - §7 save answer as segment (deferred at the cutoff; see §7).
- **Your manual step:** `wrangler secret put ANTHROPIC_API_KEY`, and set a spend limit in the Anthropic Console.
- **Build order:** §5 first, then §6, then §7.
- **Cutoff:** at 4:45 pm, whatever of §6 and §7 isn't live is reverted and moved to the README's "What's next". §5 is a brief requirement and is never dropped. If §5 itself isn't live by 4:45, Phase 5 is shortened to make room for it instead.
- **Tests:**
  - [workers] `test/assistant.spec.ts`
  - [workers] `test/charts.spec.ts`
  - [workers] `test/saved-segments.spec.ts` (deferred with §7; not written)
  - [static] `test/static/model-boundary.spec.ts`
- **Live check:**
  - The three example questions from §5 each return an answer, a "How I read your question" plan, and a table or chart.
  - The "What the AI saw" panel contains no email.

### Phase 5: Security, PII review, docs (16:45–18:00, 1:15; slack to 18:30, hard stop 19:00)
- **Scope:**
  - The security-reviewer and pii-auditor subagents review the whole repo against §5 and §8.
  - `/pre-audit` runs the brief's audit prompt.
  - Every finding is either fixed with a test or written into SECURITY.md.
  - README (run locally, deploy, sign and send an event with your own secret, "What's next").
  - SECURITY.md (built from Known limitations, plus Cloudflare Access for production).
  - DECISIONS.md (the interview choices).
- **Done:**
  - The five common conditions.
  - Both reviewers report no unfixed high-severity finding.
  - `/pre-audit` lists no fix that has neither been applied nor documented.
- **Live check:**
  - One full pass of all three pages and a live webhook send, on the deployed URL after the final CI deploy.

## Out of scope
- CSV upload endpoint (the import is a script).
- Partial or fuzzy search, and CSV/Excel export.
- Gmail dot and `+tag` merging, and fuzzy or probabilistic identity matching.
- Merging two profiles after the fact (for example, an unknown app user who later turns out to be a subscriber).
- Multiple users, roles and audit logs. There is one shared password.
- Batch webhook payloads (one event per request) and webhook secret rotation tooling.
- Sending segments to external tools (beehiiv, ads), and scheduled jobs.
- The model seeing or reasoning about individual people.

## Known limitations
- **Shared password:** no per-user accountability, and anyone with the password sees every email. Production would use Cloudflare Access.
- **Rate limiting:** the binding's counts are per Cloudflare location and approximate, so it doesn't stop a distributed attacker.
- **Rate-limit tests:** the 429 paths are proven with a fake limiter. The real binding is only shown to be wired up (one request succeeds), because Miniflare's counters are shared across tests and reset on the wall-clock minute, which would make a real over-limit test flaky.
- **Replay:** the webhook replay window is 5 minutes. An event replayed within it is absorbed by `event_id` dedupe, but a replay with a fresh `event_id` would require the secret.
- **Duplicate events:** the first write wins. A later duplicate with corrected data is ignored.
- **Device attribution:** it is inferred by time, so a device shared without logging out can attribute anonymous events to the wrong person.
- **Unowned events:** anonymous events from devices that never log in belong to no profile.
- **Unknown app users:** an unknown `user_id` gets a profile with no email, which is never merged with a subscriber later.
- **Email normalization:** trim and lowercase only, so `a.b@gmail.com` and `ab@gmail.com` are different people.
- **Today is fixed:** the "today" constant makes all time windows static. Live events dated after `TODAY` count in every window, by design.
- **Engagement weights:** they are a judgment call and haven't been validated against outcomes. The newsletter side uses only the last open date, because the data has no open counts.
- **Question scrubbing:** it catches emails (including spelled-out and encoded forms) and ID patterns, and blocks first-and-last-name pairs that match a stored email. A name that is in no stored email, or a first name alone, still reaches the model if typed.
- **One tool per question:** questions that need two steps (e.g. "compare cold rates for Instagram vs Google signups this month and last") can't be chained. The model picks the closest single tool or `unsupported`.
- **Misreadings:** the model can misread a question into the wrong filters. Answers are templated from real results, so the numbers are right for the plan it chose, and the UI shows that plan so the user can catch a misreading.
- **Sessions:** the sessions table grows until the next login cleanup runs.
- **Scale:** D1 single-region writes and read-time joins are fine at this size but would need materialized links at scale.
- **D1 read budget:** the free plan allows 5M rows read per day, and the live site hit it. Cause: `visitor_links.profile_id` and `user_links.profile_id` had no index, so every per-profile subquery (score, `min_site_visits`, `has_app`, lookup joins) was a full scan, which is quadratic in profiles, and the segment preview read profiles joined to subscribers four times (count, rows, by_source, by_status). Fixed by migration 0003 and by `previewSegment` making one pass over the matching profiles (source, status and score per row) and deriving the count, the chart groups and the top 50 in JS. The budget is under 25,000 rows read per UI call (`npm run perf` marks a call at 25,000 or more as OVER BUDGET and exits 1), measured with `npm run perf` on the local real-data D1 (2,941 profiles, 10,000 web events, plus the 4,609 seeded app events on 300 devices and 2,670 device links that `npm run perf` loads with `INSERT OR IGNORE`):

| Call | Before | After |
| --- | --- | --- |
| lookup by email | 12 statements, 31,963 rows (before migration 0003) | 10 statements, 181 rows |
| preview: instagram, not opened 30 days | 5 statements, 1,767,268 rows (before 0003) | 2 statements, 6,391 rows |
| preview: no filters | 5 statements, 28,571,280 rows (before 0003) | 2 statements, 22,274 rows |
| lookup: profile with app activity (74 owned events) | 12 statements, 18,563 rows (view join) | 10 statements, 546 rows |
| preview: app_active_days 30 | 2 statements, 2,552,866 rows (view join) | 2 statements, 8,171 rows |
| preview: app_active_days 90 | 2 statements, 6,896,519 rows (view join) | 2 statements, 13,930 rows |
| preview: app_active_days 30 + instagram | 2 statements, 748,893 rows (view join) | 2 statements, 9,372 rows |
| import report | 2 statements, 22 rows | 2 statements, 22 rows |
| session gate | 1 row | 1 row |

  The app side had the same problem in a different form. The `app_event_owner` view computes `owner_user_id` per event, so `owner_user_id = user_links.user_id` cannot use an index, and every per-profile subquery (lookup activity, `engagementFor`, the score, `app_active_days`) scanned every event once per profile. Phase 3 fixed it two ways (migration 0004 adds the indexes). Lookup reads only the events a profile can own: events with one of its user_ids, plus anonymous events on devices that have a `device_links` row for one of those users, with the view still deciding the owner. Segments compute app points once per query in one pass over the events in the window, grouped by owner and then by profile, and `app_active_days` is an uncorrelated `IN` subquery that runs once. An unfiltered preview still scores every profile, so its cost grows with profiles and in-window events (linear).
