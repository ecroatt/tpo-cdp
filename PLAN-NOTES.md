# TPO mini CDP: plan notes for Claude Code

Input for the SPEC.md interview. The assessment brief is `TPO_Developer_Assessment.pdf`; these notes are my decisions and what I found in the data. Where they conflict, the PDF wins. All the OPEN calls were decided on Sat Oct 17 (see "My calls").

## Constraints
- Due with my application by Mon Oct 19, 2026; I plan to turn it in Sun Oct 18. Saturday Oct 17: start ~10:15, aim to finish ~6:30 pm, hard stop 7 pm. Sunday: ~2 hours (final audit, Loom, submit).
- Submission is one folder link (Google Drive, OneDrive or Dropbox, view access) holding a submission doc (live URL, webhook URL, repo link, UI password, raw audit output, Loom link) plus my resume. The repo goes public at submission.
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

## Loading the CSVs
- Import script (`npm run import`), not an upload page. Idempotent: running it twice gives the same counts and creates no duplicates.
- The CSVs are gitignored (they contain names and emails). data/README.md tells reviewers to put the three assessment CSVs there.

## Tables (D1)
profiles, subscribers, web_events, visitor_links, app_users, app_events (event_id PK), device_links (device_id -> user_id), import_report.

## Webhook: POST /webhooks/app
- Auth: HMAC-SHA256 over `timestamp + "." + rawBody` in headers (e.g. X-Signature, X-Timestamp), secret from `wrangler secret`, constant-time compare, reject if older than 5 min, 401 with no details. Rate limit, body size cap, JSON content-type check.
- Validate: event in {app_open, read_story, link_click, login}; required fields present; else 400, not stored.
- Duplicates: INSERT OR IGNORE on event_id, still 200.
- Out of order: store the event's own timestamp; always sort by event time; "last seen" = max event time.
- Login stitching: any event with device_id + user_id writes device_links; profile = events with that user_id OR any linked device_id (works even when anonymous events arrive after the login).
- Unknown user_id: create app_users row + "unknown app user" profile.
- Reviewer access: the live WEBHOOK_SECRET is NOT shared. The webhook is shown live in the Loom; reviewers test it locally with their own secret via the README and `npm run send-events`.
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
- Model: Claude Haiku 5.5 via the Anthropic API (~$0.0025/question). Key in `wrangler secret` as ANTHROPIC_API_KEY, spend limit set in the Console. Provider stays behind sendToModel().

## UI
- Password protection: one shared password checked by the Worker. Stored as a Worker secret (UI_PASSWORD), constant-time compare, HttpOnly + Secure session cookie. It protects the pages AND every /api route (only /webhooks/app is outside it, protected by HMAC). In production I'd use Cloudflare Access instead; say so in SECURITY.md and README.
- Pages: lookup (newsletter info, site visits, app activity on one screen), segments (filters, count, list, chart), assistant.
- Carry over from Grounds: CSP + security headers, generic errors, no emails in logs, .bind() everywhere.

## Extras (after the five work)
- Lead: chart answers (assistant + segments) with Chart.js.
- Second extra: save answer as segment (a button on any assistant answer saves it as a reusable segment). A third only if time is left. Cut first if behind.

## Claude Code setup to create
- Subagents: verifier, security-reviewer, pii-auditor, tutor.
- Skills: /pre-audit (runs the PDF's audit prompt and lists fixes), /ai-was-wrong (appends to AI_LOG.md).
- Stop hook: run `npm test`. Keep the secret-file PreToolUse hook from Grounds.
- Repo docs: README (run locally, deploy, how to sign and send an event with your own secret), SECURITY.md, DECISIONS.md, AI_LOG.md.

## Setup
  "d1_databases": [
    {
      "binding": "tpo_cdp",
      "database_name": "tpo-cdp",
      "database_id": "4584d2ec-bd1a-4927-aada-b75ee717b407"
    }
  ]

## My calls (Sat Oct 17)
- AI model: Claude Haiku 5.5. Better answers in front of reviewers, and room to test a lot without a daily cap.
- UI login: shared password, because the PDF says basic password protection is fine and it's the easiest thing to hand reviewers. Production: Cloudflare Access.
- Second extra: save answer as segment, so a teammate can reuse a list instead of asking again.
- CSV loading: import script. The CSVs are a one-time load; a script is quicker to build and test, doubles as the README setup step, and skips an upload endpoint that needs its own security.
- Webhook secret: not shared with reviewers, for security. Live demo in the Loom; local testing with their own secret.
- CSVs kept out of git (removed from history Oct 17) since the repo goes public.
