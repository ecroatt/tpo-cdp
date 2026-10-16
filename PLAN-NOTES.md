# TPO mini CDP: plan notes for Claude Code

Input for the SPEC.md interview. The assessment brief is `TPO_Developer_Assessment.pdf`; these notes are my decisions and what I found in the data. Where they conflict, the PDF wins. Items marked OPEN still need my decision.

## Constraints
- Due with my application by Sun Oct 19, 2026. About 10 hours total, mostly Saturday.
- Treat 2026-09-28 as "today" for anything time-based.
- Stack: Cloudflare Workers (TypeScript) + D1 + wrangler, GitHub Actions (test on PR, test + deploy on main). Same stack as my Grounds project.
- Build in order: Req 1 > 2 > 3 > 4 > 5 > extras. Extras only after all five work live.
- The repo will be audited by an AI using the prompt at the end of the PDF. So: one shared `normalizeEmail()`, real tests, no TODO/stub comments (unfinished work goes in README "What's next"), small commits, and known issues written down in SECURITY.md.

## Data findings (checked Oct 15)
- subscribers.csv: 2,995 rows. 8 fully blank rows. 85 emails appear twice once trimmed + lowercased (exact match finds only 7). Duplicate pairs agree on every other field. 494 rows have no last_open_date (= never opened). Status: active / unsubscribed.
- Sources: subscribers use Instagram, Facebook, Referral, Google, Direct, Podcast, X. web utm_source uses instagram, facebook, google, referral, podcast, twitter; ~80% of visits have none. One source map: lowercase, twitter -> x.
- web_events.csv: 10,000 visits, 2,028 visitor_ids, 1,400 visits carry an email (212 with capitals/spaces). No visitor has two different emails. Linking by visitor_id links ~8,400 visits.
- app_users.csv: 930 users, 900 match a subscriber; 30 (appuserN@gmail.com) don't and still need profiles.
- No app events in the CSVs. App activity only arrives through the webhook.

## Rules
- `normalizeEmail()`: trim + lowercase. One function, used everywhere. Gmail dots/+tags are NOT merged (known limitation, document it).
- Dedupe subscribers by normalized email, keep one row, count merges in an import report.
- Profiles: random `profile_id` (not a hash of the email). Types: subscriber, app-only, unknown app user.
- Link web visits: visitor_links (visitor_id -> profile_id) from any visit with an email; all of that visitor's visits attach.
- Link app users: user_id -> profile by normalized email; no match -> app-only profile.
- Link at read time, not write time: keep raw rows, join through link tables when queried.

## Tables (D1)
profiles, subscribers, web_events, visitor_links, app_users, app_events (event_id PK), device_links (device_id -> user_id), import_report.

## Webhook: POST /webhooks/app
- Auth: HMAC-SHA256 over `timestamp + "." + rawBody` in headers (e.g. X-Signature, X-Timestamp), secret from `wrangler secret`, constant-time compare, reject if older than 5 min, 401 with no details. Rate limit, body size cap, JSON content-type check.
- Validate: event in {app_open, read_story, link_click, login}; required fields present; else 400, not stored.
- Duplicates: INSERT OR IGNORE on event_id, still 200.
- Out of order: store the event's own timestamp; always sort by event time; "last seen" = max event time.
- Login stitching: any event with device_id + user_id writes device_links; profile = events with that user_id OR any linked device_id (works even when anonymous events arrive after the login).
- Unknown user_id: create app_users row + "unknown app user" profile.
- Event simulator script (`npm run send-events`): signs and sends realistic events incl. duplicates, out-of-order, anonymous-then-login.
- Tests: bad signature, old timestamp, duplicate, out of order, anonymous then login, unknown user, bad event type.

## Assistant (no PII to the model)
- Model gets only: schema description, allowed values, tool results (counts, page paths, story slugs, random profile_ids + scores).
- Tools (fixed parameterized queries, model never writes SQL): count_profiles(filters), build_segment(filters), top_pages(filters, first_visit_only), breakdown(metric, by), engagement_ranking(limit).
- User question is scrubbed: emails replaced with profile_id or [email] before sending.
- `sendToModel()` is the ONLY function that calls the AI. It scans the full outgoing payload for email patterns and refuses to send if one is found. Test proves it.
- Browser swaps profile_ids for emails via the protected API; emails never go back into the model conversation.
- "What the AI saw" toggle shows the exact request for each answer.
- Must handle the PDF's examples: "how many Instagram signups went cold last month?", "build me a list of our most engaged readers", "which pages do new subscribers hit first?"
- Model: OPEN. Workers AI (free, ~12-16 questions/day, weaker tool use) or Claude Haiku 5.5 (~$0.0025/question, $5 credit). Keep provider behind sendToModel().

## UI
- Password protection: OPEN. Cloudflare Access (allow-listed emails, one-time code) or one shared password checked by the Worker.
- Pages: lookup (newsletter info, site visits, app activity on one screen), segments (filters, count, list, chart), assistant.
- Carry over from Grounds: CSP + security headers, generic errors, no emails in logs, .bind() everywhere.

## Extras (after the five work)
- Lead: chart answers (assistant + segments) with Chart.js.
- Pick 1-2 (OPEN): reader health tiers, source quality scorecard, identity timeline, segment CSV export, live event feed, data quality page, save answer as segment.

## Claude Code setup to create
- Subagents: verifier, security-reviewer, pii-auditor, tutor.
- Skills: /pre-audit (runs the PDF's audit prompt and lists fixes), /ai-was-wrong (appends to AI_LOG.md).
- Stop hook: run `npm test`. Keep the secret-file PreToolUse hook from Grounds.
- Repo docs: README (run locally, deploy, signed curl example), SECURITY.md, DECISIONS.md, AI_LOG.md.
