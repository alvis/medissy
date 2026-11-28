# Security

Medissy is a hackathon prototype that handles **synthetic data only**. This page covers the trust boundaries, the threats, the controls with the specs that test them, and the limits that remain. It is not a compliance claim. The whole-system review is REV03 (findings P1-1 to P3-3), and every finding is fixed or recorded below as a residual.

Evidence labels: **[tested]** names the spec; **[observed]** says what was seen and where; **[inferred]** is reasoned from code or docs, not executed; **NOT RUN** has not been checked. Nothing here is deployed proof until DEP01 runs ([STATUS.md](STATUS.md)).

## Trust boundaries

| Boundary | Trusted side | Untrusted side |
| --- | --- | --- |
| A2A `/a2a/v1` | Medissy's task engine, which mints task IDs and binds identity | The calling agent, its message text, its `messageId` and any identity it claims |
| `/demo-idp` owner sign-in | The verified `at+jwt` (issuer, audience, signature, expiry, scope) and, for the portal, the ID token's `auth_time` | Any role or organisation claim; the patient issuer never confers a clinical role |
| `/institution-idp` doctor sign-in (ADR-9) | The verified `at+jwt` **and** an ID token from the same enabled institution for the same `sub` (audience, nonce, not `at+jwt`); roles = the configured role claim ∩ the configured allowlist; the organisation from Medissy's issuer config | Organisation claims in any token, roles outside the allowlist, a malformed role claim (fails closed), any request parameter naming an issuer |
| Policy → model | Records that passed policy and the field-allowlist filter | The question, source document text, and the model's output |
| Owner portal | A session with a fresh `auth_time` (step-up) | Chat messages, widget buttons, stated names and reasons |
| Box | The connector gateway, and one redirect to `*.boxcloud.com` | File contents, which are treated as data |
| Record hand-back (`submit-record`) | The bound sign-in, the registry, the confirmed connection and the grants in force | Everything in the submitted record or document, including its subject, references, text and suggested category (ADR-10) |
| Client skill | The `A2A_ALLOWED_ORIGINS` allowlist | The agent's responses (IDs, HTML, links) |

## Threats and controls

| Threat | Control | Evidence |
| --- | --- | --- |
| A caller claims to be a doctor in text | The principal comes only from the bound device sign-in (ADR-4) | [tested] `spec/disclosure/pipeline.spec.ts` "should give a free-text doctor claim from an ungranted clinician no evidence and no model call" |
| A guessed encounter | The encounter comes from the DB and must admit the caller. A guess gets the same deny as an unknown ID | [tested] `spec/policy/decide.spec.ts` "should give a guessed encounter the same deny as an unknown one (A05)" |
| Prompt injection in a question or a source document | **Deterministic policy** and the filter run before the model; the model picks IDs only; the guard rebuilds the output from records (ADR-5) | [tested] `spec/box/sync.spec.ts` "stores the malicious referral as inert data and widens nothing"; `spec/disclosure/selector.spec.ts` "model input hygiene (A05/A06)" |
| Restricted data leaks through text, the bundle, references, receipts, errors or logs | **Release guard**, field allowlists, fixed denials, content-free logs | [tested] canary suite, see [below](#canary-test-a06) |
| Release without a record | **Audit before release**: the receipt and audit are written in the release transaction, and a failure releases nothing | [tested] `spec/disclosure/pipeline.spec.ts` "should release nothing when the audit write fails, and log only content-free facts" |
| The patient never learns of requests that stop at sign-in | Every A2A request starts as an unbound task; when one expires without a sign-in it is counted for the patient per UTC day and skill (`unsigned_requests`, migration 0011) and shown on `/owner` under "Requests that never signed in", with the number still waiting. Only counts are kept: no address, message or task ID, and one row per day and skill, so callers cannot flood the log. Calls refused before a task exists (rate limit, sign-in cap, malformed JSON-RPC) are only in the content-free server log | [tested] `spec/a2a/units.spec.ts` "counts each purged unbound task for the patient by day and skill, keeping nothing about the caller"; `spec/portal/owner.spec.ts` "should log requests that never signed in as content-free day counts, including expired ones not purged yet" |
| Access continues after revocation | **Re-check on every poll**, and on every download | [tested] `spec/a2a/engine.spec.ts` "re-checks the grant on every poll (A08)", "shows a revoke on the very next poll with the production 5000 ms throttle (A08)"; `spec/sharing/a07.spec.ts` "should block the next poll of an in-flight request once its grant is revoked"; `spec/a2a/e2e.spec.ts` "runs SendMessage -> AUTH_REQUIRED -> /institution-idp approval -> GetTask -> COMPLETED with schema-valid parts, then gates downloads" |
| A duplicate request releases twice | `messageId` collisions refused (`-32602`), a request digest on receipts, polls replay without a second receipt | [tested] `spec/a2a/engine.spec.ts` "creates no second receipt for a duplicate messageId (A08)"; `spec/disclosure/hardening.spec.ts` "should refuse a reused request id carrying a different question, with a fresh-request hint and no ids" |
| A token leaks into chat, the model or the widget | The token stays on Medissy. The sign-in part carries only `verificationUri`, `userCode` and `expiresAt`. The client drops `device_code` and `*token*` keys | [tested] `spec/skills/a2a-client.spec.ts`; [observed] security review probe (see [INTEGRATION.md](INTEGRATION.md#evidence)) |
| Sign-in flooding | **Rate limits** on A2A POSTs per client IP. A **sign-in cap** of 5 waiting sign-ins per client (IPv6 by /64) and 20 per IPv6 /48. A refusal (`busy`) is JSON-RPC `-32000` | [tested] `spec/identity/rate-limit.spec.ts` "limits A2A JSON-RPC POSTs per client IP so one client cannot start unbounded sign-ins"; `spec/a2a/e2e.spec.ts` "lets one client IP hold at most 5 waiting sign-ins, so it cannot fill the global device slots"; `spec/a2a/network-cap.spec.ts` "should cap unbound sign-ins per IPv6 /48 across its /64s, leaving other networks unaffected" |
| Every client shares one rate bucket behind the proxy | Boot is refused when `MEDISSY_PUBLIC_URL` is https and `TRUST_PROXY` is not `1`. Exactly one proxy hop is trusted | [tested] `spec/server-env.spec.ts`; `spec/server.spec.ts` "trusts exactly one proxy hop for the client address". That the Sprite proxy appends the client address to `X-Forwarded-For` is NOT RUN (DEP01) |
| Locking the patient out so they can't revoke | Lockout is keyed by persona **and** client: a guesser locks only themselves | [tested] `spec/demo-idp/provider.spec.ts` "locks only the guessing client out of the owner at /demo-idp, never the patient signing in to revoke", "locks only the guessing client out of a persona after 5 wrong passphrases, never the doctor signing in from elsewhere" (the same factory guards both issuers) |
| Passphrase guessing | 5 failures per persona and client lock that pair for 15 minutes. Passphrase POSTs are rate-limited per IP. Passphrases are at least 20 characters and generated at random | [tested] `spec/demo-idp/lockout.spec.ts` "locks after the fifth failure for the rest of the 15-minute window"; `spec/demo-idp/provider.spec.ts` "rate-limits passphrase POSTs per IP before any passphrase is checked"; `spec/demo-idp/secrets.spec.ts` "rejects a short plaintext passphrase and a malformed hash" |
| Device-code phishing | The device confirm page warns that the result goes to the agent that showed the code. Grants still need the patient's step-up confirmation | [tested] `spec/demo-idp/provider.spec.ts` "warns plainly that the result goes to the agent that showed the code" |
| Cross-site form posts | **CSRF** tokens bound to the session | [tested] `spec/identity/sessions.spec.ts` "rejects a state-changing request without a CSRF token", "rejects a CSRF token minted for the other session" |
| Owner and clinician sessions confused | **Session separation**: separate sessions, HttpOnly, Secure, SameSite=Lax host cookies | [tested] `spec/identity/sessions.spec.ts` "never accepts an owner session as a clinician session", "never accepts a clinician session as an owner session", "signs the owner in with a short-lived HttpOnly, Secure, SameSite=Lax host cookie" |
| A grant forged by chat or a widget | **Step-up**: only the confirm-page POST creates a grant, after `prompt=login`, `max_age=0`, with `auth_time` ≤ 5 min (ADR-7) | [tested] `spec/portal/step-up.spec.ts` "should not let an existing issuer session satisfy step-up without the passphrase" |
| XSS from documents, questions or stated names | Escaped templates; the card's CSP is `default-src 'none'`; the client takes HTML only from completed artifacts | [tested] `spec/widgets/parts.spec.ts` "escapes every interpolation unless it is SafeHtml"; `spec/demo-idp/provider.spec.ts` "escapes markup in every dynamic value"; `spec/portal/owner.spec.ts` "should render stated names inert and label every page SYNTHETIC DEMO"; `spec/widgets/parts.spec.ts` "returns text, disclosure data and an escaped HTML card, each contract-valid" (asserts the CSP); `spec/skills/a2a-client.spec.ts` "takes html only from a completed task artifact, never from a status message or an unfinished task" |
| SSRF and redirect abuse | Gateway-only Box calls with one `boxcloud.com` redirect; a 421 host guard; the client's **origin allowlist** and manual redirects | [tested] `spec/box/connector.spec.ts` "refuses a second hop"; `spec/server.spec.ts` "answers 421 for a host other than the public one, except health checks"; `spec/skills/a2a-client.spec.ts` "refuses an origin outside A2A_ALLOWED_ORIGINS without fetching", "refuses a redirect and does not follow it" |
| A hostile agent plants shell metacharacters or option-like IDs | The **skill's shell-injection guard**: IDs must match `^[A-Za-z0-9._:-]{1,128}$`; an ID that starts with `-` is read as an ID, not an option; `--data-b64` needs no quoting | [tested] `spec/skills/a2a-client.spec.ts` "refuses a task id with shell metacharacters from the agent, and never prints it", "reads a task id that starts with - or -- as the task id, not an option (base64url ids can)", "passes an apostrophe question intact through a real shell, both as --data-b64 and as --data quoted with the rule" |
| Forged tokens | `at+jwt` only; algorithm and issuer allowlists; doctor roles only from the institution's ID token, intersected with the allowlist | [tested] `spec/identity/verifier.spec.ts` "rejects an ID token used as an access token", "rejects HS256 signed with the public key as the secret (alg confusion)" |
| A doctor's token claims another organisation or role, or mixes tokens | The organisation comes from the issuer row, never a claim; the access token and ID token must share issuer and `sub`; the role claim is shape- and length-checked; a patient-kind issuer never yields roles; exactly one enabled institution | [tested] `spec/identity/verifier.spec.ts` "ignores an organization or org claim in the ID token", "rejects an ID token for another subject than the access token", "rejects an ID token from another issuer than the access token", "fails closed on a role claim of the wrong type or absurd size, dropping earlier roles", "never reads roles from a patient-kind issuer"; `spec/vault/migrate.spec.ts` "allows exactly one enabled institution" |
| A hospital removes a doctor's role, but Medissy still trusts it | Roles are recomputed at every institution sign-in; policy reads the registry only under an enabled institution and treats no roles as unknown; the patient's `suspended` flag is never overwritten | [tested] `spec/identity/verifier.spec.ts` "drops access at the next sign-in once the institution removes the role", "keeps the patient suspension across a just-in-time re-sign-in"; `spec/policy/engine.spec.ts` "reads an entry only while its issuer is an enabled institution" |
| The Agent Card reveals the patient's hospital | The card advertises no issuer or security scheme | [tested] `spec/a2a/e2e.spec.ts` "serves a generic Agent Card that round-trips the SDK schema and names no patient data" |
| A clinician without an active grant files into the patient's record, or probes who has access | After the device sign-in binds, filing needs an active registry entry, a confirmed connection and an allow grant in force whose encounter admits the caller. Otherwise the clinician gets the clinical denial text and nothing is uploaded | [tested] `spec/a2a/e2e.spec.ts` "should give a clinician without an active grant the uniform denial and file nothing", "should deny uniformly once the grant is revoked, filing nothing"; `spec/inbound/service.spec.ts` "denies uniformly and files nothing without a grant, a connection or a registry entry", "denies uniformly and files nothing once the institution removes the clinical role" |
| A handed-back record targets another patient, smuggles content or links, or is oversized | Strict contract (64 KiB, bounded depth, strings and arrays; no `contained`, no attachment URLs). References to another patient are refused, and Medissy sets the subject. Control and bidi characters are stripped. The record is stored `unverified` and rendered escaped. The category must be covered by the grant | [tested] `spec/inbound/service.spec.ts` "refuses %s", "refuses a reference to another patient and files nothing", "refuses a category outside the grant and files nothing", "stores injection text inert: control and bidi characters stripped, text kept as data" |
| The upload is steered to another folder or host | Medissy fixes the parent folder and a safe generated name. It sends no credential, refuses every redirect, and accepts only a one-entry reply in that folder with the same name and size | [tested] `spec/box/store.spec.ts` "posts one multipart upload, attributes first, into the fixed folder with no credential", "refuses %s" |
| A record the patient removed is still released | Remove sets `entered-in-error`, which is final. Policy releases only `current` records, and polls re-check | [tested] `spec/inbound/service.spec.ts` "marks the record entered-in-error, audits it, and policy never releases it again"; `spec/portal/inbound.spec.ts` "should refuse Remove with a forged CSRF token and change nothing" |

## Canary test (A06)

Every restricted fixture record, and only those records, carries a canary string. The tests assert that it never leaves the vault.

| Check | Evidence |
| --- | --- |
| The canary sits in restricted records only | [tested] `spec/fixtures.spec.ts` "puts the canary in every restricted record and in no other record" |
| No output carries it, even under a grant that covers restricted records | [tested] `spec/disclosure/pipeline.spec.ts` "should keep the canary and restricted ids out of every output under a grant that covers them" |
| Failure paths don't carry it | [tested] `spec/disclosure/pipeline.spec.ts` "should keep the canary out of denials, receipts, audit and logs when the release fails" |
| The model never sees it | [tested] `spec/disclosure/selector.spec.ts` "never sends restricted records, the canary or ids outside the allowed set" |

## Model processing, data and failure behaviour

- **Model.** Anthropic receives only filtered, authorized synthetic records and the bounded question. Without `ANTHROPIC_API_KEY`, no call is made and the baseline is released (ADR-5). A live call is NOT RUN.
- **Storage.** One SQLite file at `DATABASE_PATH` on the Sprite disk. The `/demo-idp` and `/institution-idp` signing keys are separate rows, each encrypted with `DEMO_IDP_KEY_ENCRYPTION_KEY` [observed in `src/demo-idp/keys.ts`].
- **Retention.** Unbound tasks are purged at expiry with their device codes, after being added to the patient's day counts of requests that never signed in [tested] `spec/a2a/units.spec.ts` "purges unbound tasks past their expiry with their sign-ins and IdP device codes, keeping the rest". Tasks expire after 1 h by default [observed in `src/a2a/engine.ts` `DEFAULT_TASK_TTL_MS`]. Receipts and audit are append-only [tested] `spec/vault/migrate.spec.ts` "blocks UPDATE".
- **Backup.** No backup or retention job ships in `src/` [observed in the module tree]. Sprite checkpoint behaviour is NOT RUN (A13).
- **Logs.** Method and path only, never query strings. Pipeline logs carry stage, codes, counts and latency. [observed in `src/server.ts` and `src/disclosure/run.ts`]
- **Failure.** Every gate fails closed with a fixed denial [inferred from the gate code; individual denials are tested per control above].

## Known limits

| Limit | Impact | Status |
| --- | --- | --- |
| **D10: the task ID is the only poll secret** | Anyone holding a task ID can poll that task's result until it expires or its grant is revoked. Another clinician is not stopped by identity. | A08 **PARTIAL** (ADR-4) |
| Device-code phishing | Whoever gets a person to approve their user code receives that task's result. For a share code, that is the invitation, though the patient must still confirm before any grant. | Accepted under D8 and D10. Mitigated by the confirm-page warning |
| Passphrase guessing by rotating IPs | Each IPv4 address or IPv6 /64 gets 5 guesses per 15 minutes, with no limit across clients. | Mitigated only by random passphrases of at least 20 characters. A global per-persona throttle is deferred |
| Filling the global sign-in cap | About 50 IPv6 /48s, or 200 IPv4 addresses, can fill the global cap of 1000 waiting sign-ins, so new requests get `busy` until the codes lapse. | Residual of REV03 P2-2 |
| The count of unsigned requests can be inflated | Anyone can raise the "never signed in" counts by starting tasks (within the rate limits and sign-in cap). The counts can alarm, but they hold nothing and release nothing. An expired task is counted when the next task is opened or the patient opens `/owner`; nothing deletes the counts except a vault reset. | Accepted |
| Revocation can't retract released data | It blocks future polls and downloads only. | By design (brief §8) |
| `/demo-idp` and `/institution-idp` are not real IdPs | Both run in Medissy's process with synthetic personas. A process compromise is an issuer compromise, including the institution's role claims. Production swaps in the hospital's own IdP behind `IssuerConnection` (ADR-3, ADR-9). | Departure I-3; a real external IdP is NOT RUN |
| The verification URI names the institution | Whoever starts an A2A task sees the `/institution-idp` link in AUTH_REQUIRED, which reveals the one trusted hospital to that unauthenticated (rate-limited) caller. The card itself names none. | Accepted residual (ADR-9) |
| Role changes apply at the next sign-in | A doctor's open session (at most 30 min) or already-bound task keeps the roles it was verified with. The patient's `suspended` flag acts at once. | By design (ADR-9) |
| One trusted institution | The schema allows exactly one enabled institution. | By design (ADR-9) |
| A handed-back record is shareable before the patient reviews it | Untrusted clinician content can reach another granted clinician before the patient removes it. | Accepted (ADR-10). Mitigated: active grant and covered category only, stored `unverified` and inert, the selector picks IDs only, owner receipt and Remove |
| Orphan file after a failed hand-back | If the grant is revoked between upload and import, or the import fails, the file stays in Box with no vault record. Remove also leaves the file in Box. | Audited (`record.submitted` error or denied). Medissy has no Box delete permission |
| Who wrote a handed-back record | Under D10 any caller can start a hand-back; the record is filed under the doctor who approves the sign-in. The sign-in page previews the record's kind and caller-sent title (unverified), but a doctor who approves a code they did not start can still have someone else's content filed under their name. | Accepted (ADR-10, D10). Mitigated: the preview, the task-code comparison on the sign-in page, active grant only, owner receipt and Remove |
| Not a legally compliant consent system | Grants are a demo authorization model, not FHIR Consent or a legal record. | By design |
| HTML rendering depends on the client's `show_widget` sandbox | Medissy escapes and sets a CSP. Whether OpenClaw sandboxes the widget is unverified. | NOT RUN (SPK04) |
| The Box connector is account-wide (`root_readwrite`) | Contained by a Box account that holds only synthetic data. | A01 NOT RUN |
| Secret scanning | Not verified for this build. | Unverified |

## Production hardening beyond the demo

These are pointers only; none is built.

| Residual | What production would change |
| --- | --- |
| In-process demo issuer (I-3) | An external IdP behind `IssuerConnection`, with proofed clinician identities |
| D10: the task ID is the only poll secret | Per-client A2A credentials, so a task is bound to its calling agent as well as to the person |
| IP-rotation guessing and filling the global sign-in cap | A global soft throttle per persona and per pending-sign-in pool, on top of the per-client limits |
| An unauthenticated Agent Card | A signed Agent Card, so clients can verify they reached the patient's own Medissy |
| Device-code phishing | Falls away with per-client credentials. Until then, share codes could be issued only in the owner portal |

## Tested versus untested

| Area | Tested locally (vitest) | Untested |
| --- | --- | --- |
| Identity | Verifier, device flow, sessions, CSRF, step-up, per-client lockout, passphrase length, rate limits, boot-time proxy check | Device flow behind the Sprite URL (SPK05); the proxy's `X-Forwarded-For` |
| Disclosure | Policy, filter, selector fallbacks, guard, audit-first, canary | Live Sonnet 5.5 call |
| A2A | Card, AUTH_REQUIRED → COMPLETED, re-check, revocation, expiry, collisions, sign-in caps | Any client other than the skill against the Sprite |
| Sharing | Invitations, step-up confirm, A07, connection ended on revoke | QR scanned in OpenClaw desktop |
| Box | Gateway client with stub gateway, ingest, conflicts | Real connector I/O (A01) |
| Client | `spec/skills/a2a-client.spec.ts` against in-process Medissy | Model-driven OpenClaw turn, `show_widget` (A12) |
| Platform | Host guard, proxy trust | Wake, persistence, latency (A13) |
