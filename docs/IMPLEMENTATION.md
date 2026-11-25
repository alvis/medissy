# Build Medissy — implementation brief for a coding agent

**Mission:** Build and demonstrate a real, single-patient, patient-controlled health information envoy running on a Fly Sprite, using the official Box connector, A2A with OIDC-backed OAuth access tokens, and a clinician-facing OpenClaw generative UI integration. This is a Hacksgiving 2026 prototype with synthetic records only.

Read the root README before implementation. Treat this file as the authoritative MVP brief; update the README to reflect what actually ships. Do not claim a mock integration is live. Keep the code deployable, testable and easy for a judge to understand.

## 1. Product thesis

A patient's longitudinal health information is fragmented between clinics, hospitals, personal documents and devices. Medissy gives one patient a persistent, independently addressable representative that maintains authorized copies, understands a clinician's stated purpose, and helps disclose evidence within enforceable patient-defined boundaries. It serves requests even when the owner is offline, provided the grant is valid. It is not a diagnostic assistant or a hospital EHR. It complements existing clinicians and personal AI agents rather than replacing them.

**North star:** One address, independently verified clinicians, purpose-specific records, and a receipt for every disclosure.

The demo must make the distinction from a general-purpose skill clear: an external clinician can independently invoke a real authenticated service; the service maintains patient-specific policy and audit state and refuses unauthorized requests regardless of the caller's instructions. The patient may use a chat client to interact, but no patient chat session is required for standing grants.

## 2. Scope and hard constraints

- One fictional patient, one Sprite, two authorized clinicians, one authenticated but untrusted clinician, one unauthenticated caller. Do not store or accept real PHI in this prototype. Clearly mark every UI and fixture as synthetic; restrict access to demo users and do not expose real-data upload forms.
- Required: actual official Box connector read/download, real A2A JSON-RPC client/server call, OIDC login and API access-token validation, deterministic consent engine, structured evidence result, patient-side audit and revocation, OpenClaw chat widget (with authenticated portal fallback), registered Sprite service.
- Strong preference: TypeScript, Node.js 24 LTS, pnpm, Fastify, Zod, `jose`, SQLite with explicit migrations, Vitest. Choose compatible, pinned versions. Use minimal React/Vite or plain HTML for owner/clinician portals. Keep deployment simple: one service on the Sprite and a test identity provider; a local dev mode may run outside Sprite. Do not introduce a multi-service framework unless necessary. Do not assume Prisma is required.
- Do not replace the source provider's official records. Imported data are copies with source attribution. No automatic diagnosis, treatment recommendation, emergency triage or clinical relevance guarantees. Do not pretend that a narrow extract is sufficient for treatment.
- No production NHS/EHR integration, real health-data exchange, automated emergency override, public patient directory, real wearable ingestion, medical device claims, compliance claims, or general-purpose agent shell access to the vault. Defer to roadmap.
- Reuse existing Open Agent infrastructure only if helpful to provision a Sprite; do not depend on T3 Code for core medical authorization. The Medissy service is itself an A2A agent. Use a bounded model call for relevance, not an autonomous shell-capable harness.
- No credentials, access tokens, raw prompts containing health data, record bodies, or private logs in GitHub, console, telemetry or screenshots. No PHI in hosted model requests in the prototype (synthetic data only). Never place Box OAuth credentials inside the Sprite.

## 3. Validate integrations first

Before building, inspect current official documentation and installed SDKs; write down exact versions and tested integration paths in `docs/INTEGRATION.md`. Reference sources at the bottom. Build small smoke tests for the following before claiming success:

1. **Sprites:** provision a named Sprite, register the service using the documented Sprite service command, bind correct HTTP port/address, configure reachable HTTPS with application auth, verify request-triggered wake after idle. Public Agent Card may be reachable but must be generic and contain no patient data. Do not expose unauthenticated clinical endpoints or the management plane. Record observed cold/warm latency; never promise emergency-grade availability. Avoid persistent busy loops and unnecessary keep-awake heartbeats. Run one authenticated operation after suspend/cold state and verify durable DB state survives.
2. **Box:** in Fly dashboard, add Box via Sprites → Connectors, approve access, restrict access to the Medissy Sprite. Use a dedicated test Box account containing only synthetic data because the connector requires `root_readwrite` and is not folder-scoped. Discover exact gateway URL and connection identifiers from connector details/discovery; run the official example from inside the Sprite. Verify folder listing, metadata, file download and optionally upload a synthetic receipt. Use a configured allowed folder and validated file IDs; do not traverse arbitrary paths or shared links. Do not pass through signed Box URLs to clients. Respect documented limits (50 MiB upload incl. multipart, 64 MiB download response); cap demo files much lower. Do not assume the connector registers inbound webhooks, supports deletion/sharing, or grants only folder permissions. Use a patient-authorized explicit Sync action for MVP. If adding a webhook, use separate Box app authorization and signed events only after confirming support; keep explicit sync as fallback. A local fixture adapter is for tests only, visibly labeled; deployed acceptance requires actual connector I/O.
3. **A2A:** pin A2A v1.0 JSON-RPC binding compatible with installed OpenClaw. Inspect official 1.0/1.0.1 spec and validate Agent Card and message/task schemas; do not mix legacy 0.3 fields/methods with 1.0. Use `SendMessage`, `GetTask`, documented task states and artifact shapes; implement required operations for the selected binding or explicitly document unsupported optional capabilities. Advertise only supported skills and formats. Enforce auth on all task operations and idempotency. If an SDK is unsuitable, implement minimal spec-compliant adapter with schema and interoperability tests; do not invent a protocol that merely resembles A2A.
4. **OIDC:** use a real development/test issuer (e.g. a configured Keycloak or hosted test OIDC tenant) with synthetic accounts. Use Authorization Code + PKCE for browser login, and a resource-specific OAuth access token for Medissy. ID tokens authenticate the login to its client; do not accept ID tokens as API bearer credentials. Validate issuer/audience/signature/expiry/not-before/scopes and subject, allowlist algorithms/issuers, and obtain verified organization/role from trusted claims or server-managed registry. A token from an arbitrary issuer or a valid clinician without a patient grant is not sufficient. Use a separate owner role and separate clinical role. Do not use user-supplied JWT claims, email-domain matching, or free-text as proof of medical status.
5. **OpenClaw:** documented bundled A2A peer configuration uses static `outboundToken` and does not perform Agent Card discovery automatically; do not rely on it for dynamic clinician identity. Implement a small OpenClaw plugin/tool adapter or a local trusted client helper that performs discovery for the configured Medissy origin and attaches the current clinician's short-lived audience-bound access token. If necessary, use browser authorization to obtain that token in a secure client-side flow or server-side session/credential broker; the raw token must never be placed in chat, model context, widget HTML, shell history, or a shared peer config. For agent delegation, use an issuer-supported token exchange or on-behalf-of flow only if available and tested; otherwise use the clinician-authorized adapter directly. Service credentials alone cannot impersonate the clinician. Document the exact tested workflow. Test `show_widget` in supported Control UI clients; remote A2A artifacts are data, not automatically renderable widgets. The adapter supplies structured result to a local trusted renderer; render only safe components, not remote HTML or executable instructions. Fallback: authenticated clinician portal and concise text, with no sensitive data in URLs. Do not claim native interoperability if only the fallback works.

## 4. Proposed repository layout

```text
README.md
AGENTS.md                        # short agent guide, references this brief
apps/
  medissy/                       # HTTP service, owner/clinician UI, A2A adapter
  openclaw-medissy/              # client integration and safe widget renderer
packages/
  contracts/                     # Zod schemas, FHIR and A2A result contracts
  policy/                        # pure deny-by-default authorization engine
  vault/                         # SQLite, import, provenance and search
  box/                           # connector adapter and fixture adapter
  disclosure/                    # candidate selection and output guard
  auth/                          # OIDC verification and session handling
fixtures/
  synthetic/                     # versioned fictional FHIR resources and source docs
scripts/                         # setup, seed, deploy, smoke, demo
docs/                           # integration, security, demo, implementation notes
```

Adjust for simplicity; modules can start as directories within one package. Use strict TS, lint, formatting and CI. No generated dependencies committed. Prefer pure functions for policy and schema validation. Keep auth, retrieval, model and release boundaries separate.

## 5. Identity and trust model

A stable patient identifier is an opaque random UUID/slug. The public URL/QR is only a locator, never an access credential. Public Agent Card describes the generic service, with no patient identifiers, names, conditions, data counts or access history. Make QR code real and tested only after deployment URL exists. Use a test host allowlist, no arbitrary destination/SSRF.

Persist patient identity, trusted issuers, verified clinician registry and patient grants. Key clinician identity by `(issuer, subject)`; optionally bind organization and role from verified registry. Distinguish owner, clinician and client application. A patient grant authorizes a specific person or vetted organization+role for a confirmed encounter and purpose, using approved categories and sensitivity classifications; organization trust alone is not enough. In MVP owner creates encounters and grants manually. Do not accept an arbitrary caller-supplied encounter ID as evidence of treatment relationship.

Suggested internal schema (not a FHIR Consent mapping claim):

```ts
type Principal = { issuer: string; subject: string; audience: string[]; scopes: string[]; organizationId?: string; roles: string[]; clientId?: string };
type Grant = {
  id: string; patientId: string; version: number;
  grantee: { issuer: string; subject?: string; organizationId?: string; roles?: string[] };
  encounterId: string; purpose: 'direct-treatment';
  categories: string[]; maxSensitivity: 'routine' | 'restricted';
  allowBaseline: boolean; allowedRecordIds?: string[];
  validFrom: string; expiresAt: string; revokedAt?: string;
};
type ClinicalRequest = {
  requestId: string; encounterId: string; purpose: 'direct-treatment';
  question: string; requestedCategories?: string[];
};
```

The server derives principal from verified token and encounter from DB, never from A2A message role or prose. Require `medissy:request` for clinical requests, `medissy:owner` plus owner identity for patient controls. Grant records are versioned, cannot be modified by model or clinician, and revocation applies at once to future requests/retrieval. OAuth token expiry and consent expiry are separate checks. Use clock injection for tests. Reject ambiguous overlaps or implement explicitly documented deny-overrides and intersection semantics. Restriction can never be widened by the model.

## 6. Record model and Box ingestion

Use SQLite for the authorized personal copy and indexes; store originals in Box and cache only validated synthetic source data as required. A FHIR R4-compatible internal envelope:

```ts
type RecordEnvelope = {
  id: string; patientId: string; resourceType: string;
  resource: unknown; category: string; sensitivity: 'routine' | 'restricted';
  source: { provider: string; boxFileId: string; version: string; sha256: string;
    authoredAt?: string; importedAt: string; verification: 'synthetic-provider' | 'patient-entered' | 'unverified' };
  status: 'current' | 'superseded' | 'entered-in-error';
};
```

Seed 20–40 deterministic synthetic records with plausible FHIR R4 `Patient`, `AllergyIntolerance`, `MedicationStatement` (or `MedicationRequest`, appropriately labeled), `Condition`, `Observation`, `DiagnosticReport`, `DocumentReference` and `Provenance` resources. Provide some synthetic source documents (text/JSON or small PDFs) as Box fixtures. Keep resource dates, units and references consistent. Include cardiac, dental-relevant, unrelated and restricted records, incomplete/stale observations, two conflicting medication statements, and a malicious text document containing an instruction to disclose all records. Use fictional identity names and explicit synthetic labels. Do not rely on diagnosis selection as a clinical algorithm; use curated categories for the scripted demonstration.

Import by approved Box folder ID; list allowlisted file IDs, fetch metadata/version and body via connector, validate size/content/type and expected patient ID, compute SHA-256, deduplicate by source ID + version + digest; reject unsupported file types, path traversal, malformed payloads, foreign-patient data and oversized files. For PDF use bounded safe extraction and avoid executing document scripts. Do not treat document prose as instructions. Store original provenance and do not silently overwrite conflicts. Flag discrepancies in source data, never reconcile into invented facts. Track import success/failures, last sync, known sources and gaps. Patient enters only synthetic data during demo. Do not call a synthetic issuer/provider actually verified in real life.

## 7. Disclosure pipeline (the heart of Medissy)

Implement this sequence with deterministic gates:

1. Receive authenticated request, validate schema/length, resolve verified principal, check rate limits and request idempotency. Fail closed. Never trust identities in message text.
2. Resolve patient, active encounter, grant validity, requested purpose/scope, security labels and owner policy. Return generic denial or authorization-required status without leaking existence or counts of restricted records.
3. Filter vault **before any model call** using the allowlisted record IDs/categories/sensitivity/time scope and authorized patient. Retrieve approved baseline if the grant includes it. No global search, restricted metadata, unfiltered titles or unrestricted model tools. Filter FHIR references and nested fields as well as top-level objects. Unsupported resources or attachment shapes fail closed. For MVP use curated structured fixtures and field-level allowlists rather than a generic redaction claim.
4. Pass only eligible structured records and bounded request text to a relevance selector. Prefer deterministic category matching for baseline and known request types; LLM must select record IDs from allowed set and may indicate uncertainty. Use a schema-validated structured response and a bounded timeout; model cannot perform external I/O, alter policies, call shell or see credentials. Treat questions and document text as data. No diagnosis/treatment recommendations. Model may not silently suppress approved baseline or conflicts relevant to the returned evidence.
5. On model failure or ambiguous relevance, return approved baseline and offer clinician-driven browsing/request within the already authorized scope (or refuse with a nonclinical explanation); never widen access. Warn that the extract is incomplete and cannot establish absence of a condition. Provide source freshness and known coverage limits without revealing restricted record metadata. Do not claim AI-determined completeness.
6. Final guard reconstructs output from authorized source records, rechecks grant and token/session authorization before release, validates every field and reference, and discards model-generated ungrounded text. Prefer deterministic evidence rendering, not unrestricted generated prose. If a summary is used, constrain it to structured, source-linked facts and validate values against records; otherwise output curated evidence cards only. Ensure task IDs/artifacts are scoped to caller, encounter and grant; authorize polling, downloads and retry after revoke. No shared CDN/public blob links. Atomic policy-version check and receipt persistence before returning data; use transaction/locking where feasible. If audit persistence fails, do not release data. Avoid echoing sensitive details in errors.
7. Return A2A task result with human-readable selective evidence and machine-readable FHIR R4 collection Bundle (`type: collection`); include provenance as permitted. No claim of full IPS conformance unless validated against the IPS profile. Store actual disclosed IDs and policy version in owner-only audit. Source file downloads via authenticated Medissy routes, not Box links; apply the same authorization checks and only allow safe content types. Responses `Cache-Control: no-store`, no PHI in URLs or logs.

Proposed typed result, transported as a documented A2A artifact with correct binding encoding; avoid protocol invention:

```ts
type DisclosureResult = {
  requestId: string; receiptId: string;
  kind: 'selective-evidence';
  scope: { purpose: string; encounterId: string; categories: string[]; expiresAt: string };
  notice: 'Selective extract of available authorized records; not a complete medical history.';
  evidence: Array<{ recordId: string; label: string; factualValue?: string;
    source: string; authoredAt?: string; importedAt: string; verification: string }>;
  coverage: { lastSyncAt?: string; limitations: string[] };
  bundle: unknown; // validate FHIR R4 resources and references
};
```

Return a separate safe `access_required` or denial result; no evidence or restricted counts. Distinguish auth failure (HTTP 401), verified but unauthorized (403 or protocol-level denied/rejected task as specified), malformed request, and temporary service failure. Do not leak information via differential errors for restricted resources. Keep audit of attempts without logging raw clinical text; owner audit may reference an internal request ID and approved purpose/category.

## 8. Patient controls and expanded-scope negotiation

Owner portal, authenticated separately, allows listing imported record sources, editing grants, approving scope requests, revoking grants and inspecting receipts. The patient can also trigger a Box sync. For each scope-expansion request record authenticated requesting subject, existing encounter, requested categories, stated reason (untrusted), desired expiry and pending state. Do not disclose new records until the owner approves an explicit scope and validity. The owner sees the proposed grant, not an opaque approval. Decline, expire and revoke are first-class. After approval issue new grant/version; clinician retries with current token and consent. No implicit approval from chat or widget JS. Use CSRF-safe state-changing routes, secure cookies, correct session separation and access controls. Support audit-only denied requests. Revocation blocks future access but cannot retract already received information from a clinician's systems. Do not present this prototype as handling legally compliant patient consent.

Receipt fields: unique ID, time, authenticated issuer+subject, organization/role if verified, encounter/purpose, grant/version, approved categories, actual released resource IDs and source versions, decision, rationale code (not private chain-of-thought), request correlation ID. Append audit events with clear distinction between denial and release. Optionally hash-chain/sign audit receipts with documented limitations; do not claim tamper-proofness. Never put restricted record identifiers or vault-wide counts into clinician-visible receipts. Owner may inspect full disclosure ledger. Minimize logs and have an explicit demo cleanup path.

## 9. Interfaces and communication

- `GET /` — clinician portal with generic landing before auth; owner portal separate `/owner`.
- `GET /.well-known/agent-card.json` — generic A2A card advertises actual HTTPS endpoint, supported protocol and OAuth/OIDC security scheme. No patient data.
- `POST /a2a/v1` — A2A JSON-RPC, authenticated every operation. `SendMessage` accepts a text clinical question with structured encounter metadata if supported by pinned version; otherwise safe JSON-in-text contract documented. `GetTask` is caller-bound and reauthorizes artifacts. Generate distinct context IDs per encounter/principal. No caller-provided role as authentication. Support asynchronous task handling with durable status and restart recovery if necessary; simple synchronous demo acceptable if timeouts measured. Do not create reverse messages or callbacks carrying data to unverified URLs. Reject unsupported notification URLs and streaming unless explicitly implemented.
- Portal routes for request, expansion, authenticated artifact download and owner grants/audit. Exact REST path names are implementation decisions. Shared disclosure service used by browser and A2A; avoid separate authorization implementations.
- `GET /healthz` — generic minimal service liveness, no patient data. Secure management endpoints and avoid exposing environment details.

OpenClaw adapter: configured Medissy URL, secure login helper, client session store, typed tool `medissy_request` with question/encounter/purpose and `medissy_request_expansion`; fetch and validate agent card and A2A result; enforce allowlisted origins, no insecure redirects. Use local safe templates rendered with `show_widget` for clinical timeline/evidence cards, record provenance, approved scope, selective warning, expansion action and receipt ID. All actionable buttons must initiate a fresh authenticated backend request via trusted adapter/portal, not grant permissions locally. Widget is display-only if authenticated callbacks cannot be safely supported. Escape HTML; no external scripts, remote record HTML or bearer in widget; avoid sending data to model/client contexts beyond approved recipients. For demo, use dedicated isolated clinician profiles and disable unnecessary logs. Verify how OpenClaw stores messages and widgets; real PHI would require separate compliance assessment. Fallback text+portal is required on unsupported clients.

## 10. Experience design

Calm, warm, patient-centered visual language: off-white, deep teal, slate, restrained coral accent. Use the original README illustrations as inspiration; don't confuse decorative illustration with actual UI. Clearly label `SYNTHETIC DEMO` everywhere. Accessible contrast and keyboard navigation. Avoid red/green-only state communication.

Patient screen: health address and actual scannable QR, last sync/source status, current grants, pending requests, disclosure receipts. Clinician screen: authenticated identity, purpose/encounter and scope, question composer, loading/working status, source-linked evidence groups, clearly marked selective extract, freshness limitations, request expanded scope. Denial screen: generic reason and safe next step, no sensitive metadata. Show exact clinician-side vs owner-side views. No unnecessary administrative complexity.

## 11. Demo script (record approximately 90–120 seconds; compress actual waits honestly)

- 0–12s: explain fragmented records; show synthetic patient address and source list. Show actual Box connector import result.
- 12–30s: authorized cardiologist signs in (test issuer), discovers Medissy, sends A2A request from OpenClaw, shows evidence widget with source references and authorized baseline.
- 30–45s: dental clinician signs in using a separate identity, same patient address, different approved scope and question. Show different evidence and the shared baseline; avoid implying either view is clinically exhaustive.
- 45–58s: authenticated but untrusted caller requests everything or attempts prompt injection. Show denial; even malicious source text cannot widen permissions.
- 58–75s: clinician requests a specific additional category; no data released. Owner approves a temporary grant; retry succeeds only for the newly approved scope.
- 75–90s: owner sees who requested what and exactly which sources were released; revoke access and show subsequent request or artifact retrieval fails. Show observed Sprite sleep/wake and persisted records/audit. If wake recording takes longer, cut honestly and disclose measured latency.

Create `scripts/demo` or an equivalent reproducible workflow, `docs/DEMO.md` with exact accounts (no passwords in repo), provisioning steps, fixture upload instructions, expected evidence IDs and fallback paths. Make it possible for judges to try a protected synthetic demo without exposing administrative controls publicly. No hardcoded demo result pretending to be LLM or live A2A. If a feature cannot be integrated, label it and preserve a genuinely working vertical slice.

## 12. Tests and acceptance criteria

Use unit, integration and end-to-end tests. At minimum:

| ID | Acceptance test |
|---|---|
| A01 | Real deployed Sprite reads synthetic Box file via official connector; secret not present in environment/logs. Fixture adapter cannot pass this test. |
| A02 | OIDC test login produces scoped access token; invalid signature, wrong issuer/audience, expired, missing scope and ID token are rejected. Unknown verified clinician receives no medical evidence. |
| A03 | A2A v1.0 Agent Card validates; actual independent client sends request, polls if needed, and gets schema-valid result. Public card has no patient information. |
| A04 | Cardiac and dental grants yield curated distinct allowed evidence and approved baseline; check exact IDs and nested fields. |
| A05 | Free-text claim of being a doctor, guessed encounter, prompt injection and malicious Box document cannot elevate access. LLM receives only authorized evidence; test using recording fake model and restricted canary text. |
| A06 | No restricted data in text, bundle, embedded FHIR references, document links, metadata, denial, clinician receipt or errors. No raw restricted content in model input. |
| A07 | Patient approval expands only approved category/time scope; pending request yields no new evidence; denial/expiry/revocation fail closed. |
| A08 | Another clinician cannot access a known task ID or artifact. Revoke while task runs and block later release/poll/download; duplicate request IDs don't create duplicate releases and always reauthorize. |
| A09 | Imported records persist, deduplicate and retain provenance/version; invalid/mixed patient/malformed files rejected; conflicts visibly preserved. |
| A10 | Every actual release has durable owner audit event; deny attempt recorded; audit write failure blocks release. No sensitive logging. |
| A11 | Model unavailable, invalid output, hallucinated record ID, timeout or ambiguous result yields approved baseline/controlled fallback or refusal, never widened disclosure. |
| A12 | Real OpenClaw client adapter demonstrates clinician-bound access token and supported inline widget; unsupported clients get authenticated portal fallback. Document actual observed capabilities. |
| A13 | Real Sprite service wakes on HTTP after idle, handles authenticated request, retains DB/audit across restart. Measure elapsed times; no SLA claim. |
| A14 | CSRF/session boundary, replay/idempotency, XSS from document and question, SSRF via URLs, cross-principal access, size/rate limits, secret scanning tests. |

Track statuses as PASS/FAIL/NOT RUN with commands, environment and results. Don't mark a mock or local test as deployed proof. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` should succeed; include actual setup scripts and `.env.example` with placeholders only. Add CI without live credentials; deployed smoke tests run explicitly with authorized environment. Prioritize A01–A11 and A13 over polish if time limited; do not relax security boundaries to make demo easier.

## 13. Implementation order and deliverables

1. Read docs; create integration spike and freeze versions. Confirm Box access and test issuer prerequisites. If missing, document setup and proceed with local fixtures transparently.
2. Build fixture model, migrations, authorization and policy tests first.
3. Build Box adapter, sync and source provenance; verify actual connector on Sprite.
4. Build shared disclosure service, structured model selector, guard and audit; add adversarial tests.
5. Build authenticated browser and A2A endpoints; verify end-to-end independent client.
6. Implement OpenClaw adapter/widget and portal fallback; verify dynamic access-token handling in actual client.
7. Implement owner grants, expansion and revocation; exercise races/authorization rechecks.
8. Deploy Sprite service, test real idle/wake and durable persistence, record demo and final limitations.

Deliver source, tests, lockfile, migrations, fixture upload/seed scripts, setup/deployment instructions, versioned integration notes, threat model, demo guide, final status table and updated README. Include a `docs/SECURITY.md` describing trust boundaries, data flows, model processing, permission revocation, connector scope, audit limitations, data retention, backup and failure behavior. Record decisions and unresolved items. Commit logically in Git; do not push real secrets or fixtures derived from real patients. Do not change unrelated repositories. If no target remote is configured, stop after local commits and report the blocker; if authorized target remote exists, push the implementation branch and report the exact URL.

## 14. Beyond the hackathon (explicitly out of scope)

Production feasibility requires independent clinical safety review, applicable healthcare/privacy law assessment, appropriate processor agreements for all services and model providers, clinically governed consent and emergency access, source authorization and identity proofing, patient matching, interoperable terminology, formal FHIR profile validation, encryption/key ownership and separation, checkpoint/backup protection, recovery, uptime/reliability and monitoring, lifecycle and data retention, accessibility, security testing, breach response, and healthcare provider onboarding. OIDC verifies identity claims from trusted issuers, not automatically clinical licensing or actual care relationship. The patient-agent cannot guarantee completeness or treatment suitability, and production disclosure rules must be designed with clinicians and patients. An emergency backup must be independently available and clinically governed. Avoid making compliance claims based on infrastructure features alone.

Potential next features: imports via SMART on FHIR/International Patient Access, provider-authorized submissions, patient-approved IPS exports, consent interoperability, delegated family access, patient-managed encryption keys, constrained emergency access and FHIR subscriptions. Do not implement these at expense of the core demo.

## 15. Official references (checked November 25, 2026)

- Hacksgiving rules: https://fly.io/hacksgiving/
- Sprites runtime and services: https://docs.sprites.dev/working-with-sprites/
- Fly connectors: https://fly.io/connectors/ and https://fly.io/sprites/ecosystem/ (Box section, exact dashboard usage)
- A2A 1.0.1: https://a2a-protocol.org/v1.0.1/specification/
- OpenClaw A2A: https://docs.openclaw.ai/channels/a2a
- OpenClaw chat and rich rendering: https://docs.openclaw.ai/web/control-ui/chat and https://docs.openclaw.ai/reference/rich-output-protocol
- OIDC Core: https://openid.net/specs/openid-connect-core-1_0.html
- JWT access-token profile: https://www.rfc-editor.org/rfc/rfc9068
- OAuth security BCP: https://www.rfc-editor.org/rfc/rfc9700
- FHIR R4: https://hl7.org/fhir/R4/ ; Provenance: https://hl7.org/fhir/R4/provenance.html ; Consent: https://hl7.org/fhir/R4/consent.html ; AuditEvent: https://hl7.org/fhir/R4/auditevent.html
- IPS: https://www.hl7.org/fhir/uv/ips/en/index.html

**Begin implementation now. Do not wait for design confirmation on reversible engineering choices. Deliver the highest-quality real vertical slice possible, clearly report missing credentials or integration limitations, and never substitute a fake demo for a verified capability.**
