# ADR-4: Clinician identity is an in-task AUTH_REQUIRED device sign-in

- Status: `Accepted`
- Date: `2026-11-25`
- Sources: discovery ledger D8, D10, q-1, q-2; brief §3.5

## Context

A clinician's agent (OpenClaw or any A2A client) must not hold or relay the clinician's token. A token in chat, model context, widget HTML or shared peer config would leak. OpenClaw's bundled A2A channel supports only static bearer tokens (q-1). A2A 1.0 defines `TASK_STATE_AUTH_REQUIRED`, and RFC 8628 lets the person complete sign-in in their own browser.

## Decision

- Every request skill (clinical evidence, invitation redemption, share code) starts as an **unbound `AUTH_REQUIRED` task**. `src/a2a/engine.ts` starts a device sign-in at the issuer the skill's flow picks: the trusted institution `/institution-idp` for clinical evidence and redemption, the patient's `/demo-idp` for share codes (ADR-9). The task returns a sign-in data part holding only `verificationUri`, `userCode` and `expiresAt`.
- **Medissy** polls the token endpoint and keeps the token. A verified clinician binds the task exactly once (triggers `a2a_tasks_bind_from_auth_required` and `a2a_tasks_binding_is_locked`, migration 0005). The pipeline then decides for that clinician, never for an identity named in message text.
- Share codes use the same path with the owner-scoped sign-in (`medissy:owner`) at `/demo-idp`. That issuer holds no clinician account, so a clinician cannot sign in to a share-code task; it stays unbound (ADR-9). An owner-scoped sign-in that is not the vault owner still leaves the task REJECTED and unbound.
- The Agent Card advertises no issuer and no security scheme (ADR-9): naming the trusted institution would reveal where the patient is treated. The sign-in is described inside the task. The JSON-RPC endpoint takes no bearer token, and the card has no security requirement.
- **D10, a known limit:** the calling agent has no credential of its own, so the **task ID is the only poll secret**. Anyone holding a task ID can poll that task. Mitigations:
  - task IDs are minted by Medissy;
  - `ListTasks` is refused;
  - a reused `messageId` returns `-32602` without the existing task;
  - every poll re-checks the grant;
  - one client IP (IPv6 by /64) may hold at most 5 waiting sign-ins, and one IPv6 /48 at most 20; A2A POSTs are rate-limited per IP;
  - a refusal for too many waiting sign-ins (`busy`) returns JSON-RPC `-32000`, so a client can tell throttling from a fault.

  Residuals: about 50 IPv6 /48s, or 200 IPv4 addresses, can still fill the global cap of 1000 waiting sign-ins. Device-code phishing is accepted under D8 and D10: whoever gets a person to approve their user code receives that task's result.

  A08 is therefore **PARTIAL** ([STATUS.md](../../STATUS.md)).

| Claim | Evidence |
| --- | --- |
| SendMessage → AUTH_REQUIRED → `/institution-idp` approval → GetTask → COMPLETED | [tested] `spec/a2a/e2e.spec.ts` "runs SendMessage -> AUTH_REQUIRED -> /institution-idp approval -> GetTask -> COMPLETED with schema-valid parts, then gates downloads" |
| The grant is re-checked on every poll, and access ends at revocation | [tested] `spec/a2a/engine.spec.ts` "re-checks the grant on every poll (A08)", "stays COMPLETED (A2A terminal states are immutable) with no artifacts and an access-ended message once the grant is revoked mid-task (A08)" |
| A messageId collision never returns the task | [tested] `spec/a2a/engine.spec.ts` "returns an error, never the task, on a messageId collision with an unbound task (A08)" |
| Per-client sign-in cap; `busy` is `-32000` | [tested] `spec/a2a/e2e.spec.ts` "lets one client IP hold at most 5 waiting sign-ins, so it cannot fill the global device slots" |
| Per-/48 sign-in cap | [tested] `spec/a2a/network-cap.spec.ts` "should cap unbound sign-ins per IPv6 /48 across its /64s, leaving other networks unaffected" |
| A clinician cannot bind a share-code task | [tested] `spec/a2a/e2e.spec.ts` "should refuse a clinician at a share-code sign-in (the patient issuer holds no Northgate staff), without binding the task or creating an invitation" |
| Works through OpenClaw desktop and the Sprite URL | NOT RUN (SPK05, A12; waits on DEP01) |

## Consequences

- No token ever reaches the client, the model or the widget. The client skill also strips any `device_code` or `*token*` key ([INTEGRATION.md](../../INTEGRATION.md#openclaw-client-skill)).
- A task ID leaked from a chat transcript lets someone read that one task's result until the task expires (1 h default) or its grant is revoked. The binding itself cannot be stolen.

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| Static peer bearer tokens | The token would sit in shared config (D8). |
| A client-side OAuth plugin | No plugin (int-6). Any A2A client must work unmodified. |
| Per-client credentials to close D10 | Not available to a generic client. The user chose the workaround (D10). |
