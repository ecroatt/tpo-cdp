---
name: ai-was-wrong
description: Appends a dated row to AI_LOG.md recording something Claude got wrong, who caught it, and the fix. Use whenever the verifier reports a gap, a test catches a mistake, or the user corrects Claude.
argument-hint: "<what was wrong> | <who caught it> | <fix>"
---

# AI was wrong

Append one row to `AI_LOG.md` at the repo root.

## Steps

1. Work out three things from the arguments or the conversation: what Claude did wrong, who caught it, and the fix. If one is missing and cannot be found in the conversation, ask the user.
   - **Who caught it** is exactly one of: `me` (the user), `verifier`, or `a test`.
2. If `AI_LOG.md` does not exist, create it with this content:

```
# AI log

Where the AI got it wrong while building this, who caught it, and how it was fixed.

| Date | What Claude did wrong | Caught by | Fix |
| --- | --- | --- | --- |
```

3. Append one row at the end of the table: `| YYYY-MM-DD | what was wrong | me / verifier / a test | the fix |`. Use the real current date. Keep each cell to one or two plain sentences, specific enough to name the file or behavior. Escape `|` inside cells as `\|` and keep each cell on one line.
4. Never put secret values, emails, or names from the data in a row.
5. Print the row you added.
