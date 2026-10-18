# Decisions

The calls I made in the Oct 17 interview, and the definitions the code uses. The Reason column is in my own words. `SPEC.md` holds the full behavior.

## My calls

| Decision | Call | Reason | Tradeoff |
| --- | --- | --- | --- |
| Stack | Cloudflare Workers, D1, GitHub Actions (same stack as my Grounds project) | Already know it, short on time, and TPO already runs on it, so they can picture adopting it | Doesn't show AWS |
| AI model | Claude Haiku 5.5 | Better answers in front of reviewers, and room to test a lot (~2,000 questions on $5) without hitting a daily cap | Costs a little per question; provider stays behind sendToModel() |
| How the assistant works | One model call that returns a plan; the server runs it and writes the answer; the model never sees results | It never touches the PII, so there's no chance of it being accessed. Even a tricked model has nothing to leak. | Answers are templated, and one tool per question (no multi-step questions) |
| UI login | One shared password the Worker checks. In production: Cloudflare Access. | The PDF says basic password protection is fine, and it's the easiest thing to hand reviewers | Access: stronger, no login code to write, but reviewers need an allowed email. Password: simple to share, but you write and protect the check. |
| UI sessions | Sessions table in D1 (token stored hashed) | More secure: logout deletes the login everywhere at once | One small database lookup per request |
| Lead extra | Chart answers on the assistant and segments | A non-technical teammate sees the answer at a glance | About 1 hour |
| Second extra | Save answer as segment: deferred, not built for submission | A teammate can reuse a list the assistant built instead of asking again. Deferred so the security audit and docs got the time. | In What's next instead of in the app |
| Loading CSVs | Import script; running it twice creates no duplicates | The CSVs are a one-time starting load, not a daily task. A script is quicker to build and test, doubles as the README setup step, and skips an upload endpoint that needs its own security. | A script is faster to build and test; an upload page looks better in the demo |
| CSVs in the repo | Kept out of git; removed from history Oct 17 | They hold names and emails, and the repo goes public at submission | One extra README step: put the 3 CSVs in data/ |
| Webhook secret for reviewers | Not shared. Live demo in the Loom; reviewers test locally with their own secret. | Security: a secret in a view-only folder link is effectively public | Sam can't hit the live webhook himself |
| Shared-device events | Attach anonymous events by time window | It checks who was logged in last on that device, so events land on the right person | A phone handed over without logging out still goes to the wrong person |
| Hosting plan | Workers Paid ($5/month) | The live site hit D1's free limit of 5M rows read per day during the build. Indexes and a perf budget now keep reads low. | $5/month |
| Top pages | Site pages (/, /subscribe, /about) left out by default; the answer names what it left out, and asking for them brings them back | The homepage and signup page aren't content. They'd top every list and hide what people actually read. | /beliefs and /our-staff still count as content; I'd add them to the list later |
| First page | First content page; someone who only visited site pages isn't counted | If someone landed on the homepage first, the article they clicked next is the real first page that drew them in. | "First page" no longer means the literal first visit |

## Definitions

These come from `SPEC.md` §0 and are the rules the code and tests follow.

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

