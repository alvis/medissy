# ADR-5: The Sonnet 5.5 selector picks record IDs only

- Status: `Accepted`
- Date: `2026-11-25`
- Sources: discovery ledger D5; brief §7.4–7.5; acceptance A11

## Context

A clinician's question ("current cardiac medications and allergies?") needs relevance ranking that fixed categories handle poorly. A model must never widen access, see restricted data, or write the clinical text that gets released.

## Decision

- `src/disclosure/selector.ts` calls `claude-sonnet-5-5` once per request. Its input is only the records that passed policy and the vault filter, plus the bounded question. Its output is a schema-validated list of **IDs from that allowed set**.
- The timeout is 20 s with `maxRetries: 0`. Without `ANTHROPIC_API_KEY`, no model is called.
- Every failure falls back deterministically to **the approved baseline intersected with the allowed set**. Failures are: no key, HTTP error, timeout, invalid JSON or schema, a hallucinated ID, an empty or ambiguous result, an over-size selection, a refusal, or truncation.
- The release text is rendered from source records by the guard (`src/disclosure/guard.ts`), never from model prose.

| Claim | Evidence |
| --- | --- |
| Each A11 failure mode falls back to the baseline | [tested] `spec/disclosure/selector.spec.ts` "A11 failure modes fall back to the baseline" (no key, HTTP error, timeout, invalid JSON or schema, hallucinated id, empty or ambiguous, over size limit, refusal); truncation in "truncated: max_tokens and pause_turn fall back as truncated" |
| The fallback is the baseline intersected with the allowed set | [tested] `spec/disclosure/selector.spec.ts` "fallback is baseline intersect allowed only, no scenario records" |
| The model never sees restricted records or the canary | [tested] `spec/disclosure/selector.spec.ts` "never sends restricted records, the canary or ids outside the allowed set" |
| The fallback releases exactly the baseline | [tested] `spec/disclosure/hardening.spec.ts` "should release exactly the baseline on fallback, even when a baseline record is linked to an allowed non-baseline one" |
| A live Sonnet 5.5 call | NOT RUN (no API key yet). Tests use a recording fake model. |

## Consequences

- Model failure degrades relevance, never safety. With no key, the demo still releases the approved baseline.
- The model's free-text `reason` is never released.

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| A model that writes the summary | Ungrounded text could leak or invent facts (brief §7.6). |
| A model with tools or a shell | Brief §2: a bounded model call, not an autonomous harness. |
| Categories only, no model | Weaker relevance. Kept as the fallback. |
