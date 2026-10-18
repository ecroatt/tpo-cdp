# Security

How the live app is protected, and what is still open. `SPEC.md` §4, §5 and §8 hold the exact rules, and the tests named there prove them.

## Webhook protection (`POST /webhooks/app`)

- **Signature:** the sender signs `timestamp + "." + rawBody` with HMAC-SHA256 using `WEBHOOK_SECRET`. The Worker recomputes it over the raw bytes, before any JSON parsing, and compares the two 32-byte digests with `crypto.subtle.timingSafeEqual` (`worker/src/webhook/verify.ts`).
- **Freshness:** `X-TPO-Timestamp` must be within 300 seconds of the Worker's clock, in either direction. Any auth failure gets a bare 401 with no body, so a caller can't tell which check failed.
- **Replays:** every event has an `event_id`, and storage is `INSERT OR IGNORE` on it. A replay inside the 5-minute window returns `"duplicate"` and changes nothing. A replay with a new `event_id` needs the secret.
- **Order of checks:** method (405), a per-IP rate limit of 120 per minute (429), body size of 16 KB checked while streaming (413), signature (401), content type (415), then validation (400). One D1 batch writes the event and any links.
- **The live secret is never shared.** Reviewers run the app locally with their own `WEBHOOK_SECRET` and `npm run send-events`.

## UI login and sessions

- **One shared password** (`UI_PASSWORD`), checked in constant time: both values are HMACed with a per-request random key and compared with `timingSafeEqual`. An empty or missing secret fails closed.
- **Login rate limit:** `LOGIN_LIMITER`, 10 attempts per 60 seconds per IP. Over the limit, the login page comes back as a 429 with `Retry-After: 60`. A login body over 4 KB gets 413 before it is parsed.
- **Sessions:** a successful login creates 32 random bytes. Only the token's SHA-256 is stored in D1 (`sessions`), with a 12-hour absolute expiry. The cookie is `__Host-session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`. Logout deletes the row, so the token stops working everywhere at once.
- **Gate:** `run_worker_first` sends every request through the Worker before static files are served. Only `/login`, `/login.css` and `/webhooks/app` are public. Pages redirect to `/login`, and `/api/*` returns 401.
- **CSRF:** a state-changing `/api` request must be `application/json` with an `Origin` equal to the site's own, or it gets 403. The `SameSite=Strict` cookie is a second layer. Lookup is a `POST` for this reason, and so the searched email never lands in a URL or a request log.
- **Headers:** a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, no inline scripts; Chart.js is vendored), `nosniff`, `Referrer-Policy: no-referrer`, HSTS, and `Cache-Control: no-store` on everything except `/login.css`.
- **Errors:** generic JSON (`{"error":"internal"}`), no stack traces. Logs record only the route, the status and the error class.
- **Production:** Cloudflare Access should replace the shared password, giving per-person sign-in, SSO and an audit trail with no login code to maintain.

## PII handling

- **Raw data stays out of git.** `data/*.csv` is gitignored and was removed from history. Test fixtures use made-up addresses.
- **The model never sees stored data.** One code path, `sendToModel()` in `worker/src/assistant/model.ts`, calls the model and reads `ANTHROPIC_API_KEY`. A static test enforces that, and also that there is no other model path (Workers AI, AI Gateway, other providers). The request holds only a fixed system prompt, the tool definitions and the operator's question after scrubbing. Query results, rows, ids and counts never go to the model. The model returns a plan, the server runs it, and the answer is written from a template.
- **The question is cleaned before it leaves the Worker:**
  - It is NFKC-normalized and zero-width characters are removed.
  - Emails and ids are replaced with `[email]` and `[id]`.
  - Spelled-out or encoded emails (`at … dot`, `%40`, `&#64;`, a spaced `@`) are refused with 422 `blocked_pii`.
  - A first-and-last-name pair that matches a stored email's local part is refused the same way.
  - `sendToModel` scans the whole request body again and refuses to send if anything matches.
- **"What the AI saw":** the assistant page shows the exact JSON body that was sent, so anyone can check it.
- **Browser output:** rows with emails go only to the signed-in operator, and the UI writes all data with `textContent`, never `innerHTML`.

## Rate limiting

| Binding | Limit | Key | On excess |
| --- | --- | --- | --- |
| `LOGIN_LIMITER` | 10 / 60 s | client IP | 429 login page, `Retry-After: 60` |
| `WEBHOOK_LIMITER` | 120 / 60 s | client IP | 429 JSON, `Retry-After: 60` |
| `ASSISTANT_LIMITER` | 20 / 60 s | client IP | 429 JSON, `Retry-After: 60`, before any model call |

Cloudflare's rate-limiting binding counts per location and is approximate, so these limits slow down a single client. They do not stop a distributed one. The Anthropic Console spend limit is the last stop for model cost.

## D1 read cost (denial of wallet)

D1 bills by rows read, so a slow query is a cost problem as well as a speed problem. The live site hit the free plan's 5M rows per day during the build, because two link tables had no index and every per-profile subquery was a full scan. After migrations 0003 and 0004 and a one-pass segment preview, every UI call is under a budget of 25,000 rows read. `npm run perf` measures every call against the real-data local D1 and exits 1 if any call goes over. `test/rows-read.spec.ts` checks in CI that reads grow linearly. The site runs on Workers Paid, so going over the budget costs money instead of taking the site down.

The remaining risk is growth. An unfiltered segment preview scores every profile, and every event since `TODAY` minus 30 days counts as "recent" (`TODAY` is fixed). So each webhook event, and each new webhook `user_id` (which creates a profile), makes later previews read more. Someone holding the webhook secret could post 120 events a minute per IP, and preview cost would keep climbing. The auth and rate limits make this expensive to do, but nothing caps it.

## Known issues

| Issue | Why it is open | Mitigation now |
| --- | --- | --- |
| Shared password, per-IP login limit only | One password for everyone; a distributed guesser can rotate IPs (for example across an IPv6 /64) | Use a long random `UI_PASSWORD` (24+ characters); move to Cloudflare Access in production |
| Rotating `UI_PASSWORD` keeps existing sessions | Sessions aren't tied to the password they were made with | On rotation, also run `npx wrangler d1 execute tpo-cdp --remote --command "DELETE FROM sessions"` |
| Names not in any stored email, or first names alone, reach the model if typed | A name can't be told apart from other words without a list of names | The name check blocks first+last pairs that match a stored email; the UI says to ask about the audience as a whole and to use Lookup for people |
| Read cost grows with webhook events and unknown users | See "D1 read cost" above | Webhook auth and rate limit, Workers Paid, `npm run perf` budget; production would materialize scores and cap the window |
| Import SQL uses escaped literals, not `.bind()` | `wrangler d1 execute --file` takes a SQL file, so the import script (`worker/src/import/build.ts` `renderSql`) writes values as SQL literals. This is the one exception to the `.bind()` rule. | It runs only from the CLI on files you supply; there is no runtime path. Quotes are doubled, NULs stripped, and CR/LF become `char()`, all covered by `test/import.spec.ts`. Production would import through the D1 API with bound parameters. |
| Rate limits are per location and approximate | A property of the Cloudflare binding | Spend limit in the Anthropic Console; Workers Paid |
| Webhook replay window is 5 minutes | Allows for clock skew | `event_id` dedupe absorbs replays inside the window |
| Sessions table grows until the next login | Cleanup runs on login only | Rows are tiny and expired ones are never accepted |
