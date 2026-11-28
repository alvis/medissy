# ADR-9: Doctor identity and role come from a trusted institution's ID token

- Status: `Accepted`
- Date: `2026-11-26`
- Supersedes: ADR-3 in part (where organisation and roles come from, and which issuer signs doctors in)
- Sources: work `medissy-mvp` brief "institution-idp"; ADR-3; ADR-4; ADR-7

## Context

Under ADR-3, one demo issuer (`/demo-idp`) signed in everyone: the patient owner and the doctors. A doctor's organisation and roles came from Medissy's clinician registry, which boot pre-seeded. In practice, a hospital, not the patient's agent, knows who its doctors are and what they do. A registry that the patient's agent keeps by hand goes stale when a doctor changes role or leaves. It also makes the patient's agent the authority on clinical status, which it cannot be.

## Decision

1. **Two synthetic issuers, one factory.** `createDemoProvider({ profile })` (`src/demo-idp/provider.ts`) builds both issuers with the same safeguards:
   - SYNTHETIC banner on every page
   - per-persona-and-client lockout
   - passphrase rules (`DEMO_IDP_SECRET_*`, at least 20 characters)
   - key encryption with `DEMO_IDP_KEY_ENCRYPTION_KEY`
   - its own signing key (`idp_store` rows `es256` and `es256-institution`)
   - its own cookies (`_northgate_*` for the institution)

   The two issuers:
   - **`/demo-idp`** is the patient's issuer (`kind = 'patient'`). It signs in the owner only.
   - **`/institution-idp`** is "Northgate Health (SYNTHETIC)" (`kind = 'institution'`). It signs in the cardiologist (role `cardiologist`), the dentist (role `dentist`) and the unknown clinician, who is now Northgate staff with the non-clinical role `administrator`.

   Persona keys, subjects and `DEMO_IDP_SECRET_*` names are unchanged.
2. **Trust is configuration.** Migration `0009_institution_issuers` adds these columns to `trusted_issuers`:
   - `kind`
   - `organization_id`
   - `organization_name`
   - `role_claim`
   - `allowed_roles` (a JSON array)

   Triggers refuse an institution without these settings, and a patient issuer with them. A partial unique index allows **exactly one enabled institution**. `ensureDemoTrust` (`src/demo-idp/seed.ts`) seeds both rows: Northgate is `org-northgate-health`, with role claim `roles` and allowed roles `cardiologist` and `dentist`.
3. **A doctor needs two tokens.** `verifyClinician` (`src/identity/institution-sign-in.ts`) requires both of these, from the same enabled `institution` issuer and for the same `sub`:
   - a verified RFC 9068 access token
   - a verified ID token: same issuer and keys, audience equal to the client that signed in, the nonce for browser sign-ins, never an `at+jwt`

   Then:
   - **Roles** are the `role_claim` values intersected with `allowed_roles`. A claim that is not an array of at most 32 strings, each 1–64 characters long, fails the sign-in (`invalid-roles`).
   - **The organisation** always comes from the issuer row. `organization`, `org` and any other organisation claim are ignored.
   - **No clinical role** means the person is an unknown clinician. They get the same uniform denial as before.

   An access token alone (`verify`) now yields identity and scopes only.
4. **The registry is just in time.** Every verified institution sign-in upserts the `clinicians` row:
   - a display name sanitised from `name`
   - the roles from the token
   - the organisation from the issuer row

   Roles are recomputed at every sign-in. A sign-in with no clinical role, or with a malformed role claim, clears the row's roles and organisation. `status` is never written, so the patient's `suspended` kill switch survives. Policy reads the row only under an enabled `institution` issuer (`readClinician`). It treats an entry with no roles as unknown (`registeredCaller`). Grants still bind `(issuer, subject)`, and the step-up confirm (ADR-7) still gates every grant.
5. **The flow picks the issuer, never the caller.**
   - Clinician flows (A2A `clinical-evidence-request` and `redeem-invitation` device sign-ins, `/clinician`, `/connect`) use the institution.
   - Owner flows (`share-code`, `/owner`, step-up confirm) use `/demo-idp`.

   `createIdentity` takes `connections: { owner, clinician }`. Each device flow is built with its own connection and verification (`src/demo-idp/compose.ts`). No request parameter selects an issuer.
6. **The Agent Card advertises no issuer.** It keeps its skills and interface, but drops the `clinicianDeviceSignIn` and `clinicianOidc` security schemes. Naming the one trusted institution would tell anyone who fetches the card where the patient is treated. Sign-in details arrive only inside a task (AUTH_REQUIRED with a verification URI), as ADR-4 already required for binding.

| Claim | Evidence |
| --- | --- |
| Roles come from the allowlisted ID token claim, the organisation from config, on a real device sign-in | [tested] `spec/identity/verifier.spec.ts` "takes roles from the allowlisted ID token claim and the organisation from the issuer config, on a real device sign-in" |
| An organisation claim is ignored | [tested] `spec/identity/verifier.spec.ts` "ignores an organization or org claim in the ID token" |
| No roles from a patient-kind issuer | [tested] `spec/identity/verifier.spec.ts` "never reads roles from a patient-kind issuer"; `spec/policy/engine.spec.ts` "never reads an entry under a patient-kind issuer" |
| An access/ID token `sub` or `iss` mismatch is rejected | [tested] `spec/identity/verifier.spec.ts` "rejects an ID token for another subject than the access token", "rejects an ID token from another issuer than the access token" |
| Wrong audience, missing ID token, an access token in its place, and a wrong nonce are rejected | [tested] `spec/identity/verifier.spec.ts` "rejects an ID token for another client, a missing one, and an access token in its place", "rejects an ID token whose nonce is not the sign-in nonce" |
| A role outside the allowlist is an unknown clinician | [tested] `spec/identity/verifier.spec.ts` "gives a role outside the allowlist the unknown-clinician result"; `spec/identity/device-flow.spec.ts` "gives a verified but unregistered clinician a principal that releases nothing (A02)" |
| A role removed at the institution means the next sign-in loses access | [tested] `spec/identity/verifier.spec.ts` "drops access at the next sign-in once the institution removes the role"; `spec/policy/decide.spec.ts` "should deny an entry whose institution no longer names a clinical role (ADR-9)" |
| A role claim of the wrong type or absurd size fails closed | [tested] `spec/identity/verifier.spec.ts` "fails closed on a role claim of the wrong type or absurd size, dropping earlier roles" |
| An untrusted or disabled issuer is rejected | [tested] `spec/identity/verifier.spec.ts` "rejects a clinician sign-in from an untrusted issuer", "rejects a clinician sign-in once the institution is disabled"; `spec/policy/engine.spec.ts` "reads an entry only while its issuer is an enabled institution" |
| The just-in-time upsert keeps grants working, and `suspended` still blocks | [tested] `spec/a2a/e2e.spec.ts` "keeps subject grants working across just-in-time re-sign-ins at /institution-idp, and still blocks a suspended doctor"; `spec/identity/verifier.spec.ts` "keeps the patient suspension across a just-in-time re-sign-in" |
| The display name is sanitised | [tested] `spec/identity/verifier.spec.ts` "sanitises the display name from the ID token" |
| The flow picks the issuer | [tested] `spec/identity/sessions.spec.ts` "signs a clinician in at the institution and the owner at the patient issuer, whatever the caller asks"; `spec/identity/device-flow.spec.ts` "refuses the patient owner at the institution: a clinician sign-in never comes from the patient issuer"; `spec/a2a/e2e.spec.ts` "should refuse a clinician at a share-code sign-in (the patient issuer holds no Northgate staff), without binding the task or creating an invitation" |
| Kind settings and one enabled institution are enforced by the schema | [tested] `spec/vault/migrate.spec.ts` "refuses an institution without its organisation, role claim or allowed roles, and a patient issuer with them", "allows exactly one enabled institution" |
| Both issuers are seeded, and no clinician is pre-seeded | [tested] `spec/demo-idp/provider.spec.ts` "disables synthetic issuers left over from an earlier public URL, keeping one institution enabled", "configures the institution with its organisation, role claim and allowed roles, and seeds no clinician" |
| The card names no issuer or hospital | [tested] `spec/a2a/e2e.spec.ts` "serves a generic Agent Card that round-trips the SDK schema and names no patient data" |
| The full A2A journey with the cardiologist at `/institution-idp` | [tested] `spec/a2a/e2e.spec.ts` "runs SendMessage -> AUTH_REQUIRED -> /institution-idp approval -> GetTask -> COMPLETED with schema-valid parts, then gates downloads"; local `pnpm journey`: 7/7 PASS |
| The same on the deployed Sprite | NOT RUN (not deployed in this change) |
| A real external hospital IdP | NOT RUN (synthetic issuer only; the `IssuerConnection` swap of ADR-3 is unchanged) |

## Consequences

- The hospital is the authority on who is a doctor and in what role. The patient's agent decides only what to share (grants, ADR-7) and can still suspend anyone.
- A role revoked at the hospital takes effect at the doctor's next sign-in, not before. A clinician session or a bound task already open keeps the roles it was verified with until it ends. Sessions last at most 30 minutes, and every poll re-checks the registry row.
- **Residual exposure.** An AUTH_REQUIRED task shows its verification URI to whoever started the task. That reveals the trusted institution to that caller, who is rate-limited per IP but not authenticated. The card itself reveals nothing.
- Exactly one institution can be trusted at a time. Supporting several needs an issuer-choice step that does not let a caller pick an issuer to attack, and a new decision.
- Registry rows written before 0009 lose their roles, so they release nothing until an institution sign-in. The deployed vault keeps its patient issuer row, which defaults to `kind = 'patient'`.

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| Keep the registry for membership and take only roles from the token | Two sources of truth for one fact. A doctor removed by the hospital would stay a member in Medissy until someone edited the registry by hand, which is the staleness this decision removes. |
| Reuse `/demo-idp` for doctors, with a roles claim | The patient's own issuer would vouch for clinical roles. That is the agent self-certifying doctors, and nothing would separate an owner's issuer from an institution's in policy. |
| Advertise the institution on the Agent Card | Discloses, to anyone, which hospital the patient uses. |
| Take the organisation from a token claim | A misconfigured or compromised institution could claim another organisation and match that organisation's grants. |
