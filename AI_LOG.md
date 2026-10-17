# AI log

Where the AI got it wrong while building this, who caught it, and how it was fixed.

| Date | What Claude did wrong | Caught by | Fix |
| --- | --- | --- | --- |
| 2026-10-17 | `passwordMatches()` in `worker/src/auth/session.ts` failed open: with `UI_PASSWORD` unset, `TextEncoder.encode(undefined)` is empty, so an empty password would log in. | verifier | Login fails closed when the secret is missing or empty, rejects an empty password, and a test covers both. |
| 2026-10-17 | `worker/vitest.config.mts` set no dummy `ANTHROPIC_API_KEY`, so local test runs loaded the real value from `.dev.vars`. | verifier | Added a dummy `ANTHROPIC_API_KEY` miniflare binding. |
| 2026-10-17 | `renderSql()` in `worker/src/import/build.ts` handled CR, LF and NUL with no test, and the injection test only string-matched the rendered SQL without running it. | verifier | Tests now execute rendered SQL with newline, CR and quote values and check the stored data. |
| 2026-10-17 | The import rule "a visitor with two emails keeps the earliest visit's email and the case is counted" had no test. | verifier | Added a fixture visitor with two emails and a test for the winner and the count. |
| 2026-10-17 | No test checked that `web_events.ts` is stored as `YYYY-MM-DDTHH:MM:SSZ`. | verifier | Added an assertion on the stored timestamp format. |
| 2026-10-17 | `worker/src/import/build.ts` trimmed raw email values in `orNull()` and `isBlank()` outside `src/lib/email.ts`, and the static scan missed it. | verifier | Moved the email blank check into `src/lib/email.ts` and tightened the scan to catch helper-wrapped trims. |
| 2026-10-17 | The dynamic-SQL static scan only checked `.prepare(` arguments, so template-literal SQL in `worker/src/import/build.ts` was never scanned. | verifier | The scan now covers `build.ts`, allowing only fixed fragments and `?` lists. |
