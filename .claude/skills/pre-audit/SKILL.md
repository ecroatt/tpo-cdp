---
name: pre-audit
description: Runs the assessment's 9-question self-audit prompt against this repo, saves the raw answers to AUDIT-PREVIEW.md, and lists fixes ranked by how bad they would look to a reviewer. Use before submitting.
disable-model-invocation: true
---

# Pre-audit

Run the audit prompt below against the current repo, the way the reviewer's AI will.

## Steps

1. Answer the prompt below yourself, as if you were the auditing AI. Read the codebase first and cite real file paths and line numbers. Do not flatter the work and do not soften findings because you wrote the code. Never read `.dev.vars` or print secret values.
2. Write your raw answers, unedited, to `AUDIT-PREVIEW.md` at the repo root (it is gitignored). Put the date at the top (use 2026-09-28 as "today" only for time-based logic in the app; for this file use the real current date).
3. Below the raw answers, add a section `## Fixes, worst first`. List every problem the answers reveal, ranked by how bad it would look to a reviewer. For each: what is wrong, the `file:line`, and the smallest fix. Put anything that is a project-rule violation or a PII path to the model at the top.
4. Print the ranked fix list in the chat. Do not apply fixes unless asked.

## The audit prompt (verbatim from docs/TPO_Developer_Assessment.pdf)

```
You are auditing this repository for a hiring review. Read the codebase before answering.
Be specific and cite file paths and line numbers. Do not flatter the work. Answer these:
1. Architecture. Describe the stack, the data store, and how data flows from CSV to store to UI
in 5 sentences or less.
2. Normalization. Where is email normalization done? Is it one shared function or repeated in
multiple places? List every location.
3. Dedupe and linking. State the exact rule used to dedupe subscribers and the exact rule
used to link web events and app users. What edge cases does it miss?
4. Webhook. How is event deduplication handled? How are out-of-order events handled?
What happens when a login event arrives for a device with prior anonymous events? What
happens with an unknown user_id? How is the endpoint authenticated?
5. PII and the assistant. Trace exactly what data reaches the language model. Quote the code
that builds the prompt or tool inputs. Can an email address, name, or raw subscriber row ever
end up in a model request or response? Answer yes or no, then explain.
6. Tests. List any automated tests that exist. If none, say so.
7. Security. List the three most serious security issues in this repo as it stands.
8. Unfinished. List anything that is stubbed, hardcoded, mocked, or marked TODO.
9. Provenance. Based on commit history and code style, estimate what share of this code was
AI-generated versus hand-written or hand-edited, and which parts show the most human
intervention.
```
