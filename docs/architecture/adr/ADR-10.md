# ADR-10: A clinician hands a record back over A2A; it is filed straight away and the patient can remove it

- Status: `Accepted`
- Date: `2026-11-26`
- Sources: brief `inbound-records` (user decision: "file straight away"); README "Later possibilities" (bidirectional provider exchange)

## Context

Until now, records flowed one way: Box → vault → a granted clinician. A clinician who writes a note or result after a visit has no way to hand it back to the patient's record. The patient's secure store is the Box folder behind the Sprites Box connector. Box is one example of secure storage, so the store must sit behind an interface.

A clinician's record is untrusted input. It may be malformed, oversized, refer to another patient, or carry text written to steer a model. Any path that accepts it must keep deterministic authorization intact, deny uniformly without an active grant, and never release a record the patient removed.

## Decision

- **Skill.** The Agent Card lists a generic `submit-record` skill. With no store configured it says "Not available in this deployment". The input is a data part: `{"skill":"submit-record","record":<FHIR R4>}` for Observation, DiagnosticReport, DocumentReference, Condition, MedicationStatement or AllergyIntolerance, or `{"skill":"submit-record","document":{"title","text","authoredAt?"}}`, from which Medissy builds a DocumentReference. An optional `category` is a suggestion. The strict zod contract is in `src/contracts/submission.ts`.
- **Bounds.** The contract caps the serialized input at 64 KiB and bounds depth, string length, array length and key count. It refuses `contained` resources anywhere and any `url` inside an attachment, `presentedForm` or `photo`. A malformed message is refused before any task exists.
- **Sign-in and grant.** The task starts as an unbound `AUTH_REQUIRED` device sign-in, the same path `clinical-evidence-request` uses (ADR-4). After the task binds, `src/inbound/grant.ts` requires an active registry entry for the bound person, a confirmed connection and an allow grant in force for the vault patient with an encounter that admits the caller. Deny grants remove their categories; baseline and restricted categories are never fileable. Without all of these the clinician gets the **same denial text** a clinical request gets, and nothing is filed.
- **Category.** The suggested category is used only when an allow grant in force covers it. Otherwise the record is refused. With no suggestion, the first covered category is used.
- **Content.** `src/inbound/record.ts` strips control, format and bidi characters from every string (document text keeps line breaks). It refuses any subject, patient or reference to another patient. It sets the subject to the vault patient and the id to a fresh record id. The record is stored as `unverified`, `routine` sensitivity, provider `clinician-submitted`, and rendered only through the existing escaping.
- **Filing.** The record is filed **straight away** (user decision). `SecureStore.upload` writes a collection Bundle named `inbound-<yyyymmdd>-<8 hex>.json`.
  - The Box implementation (`createConnectorStore`) sends one multipart `POST {gateway}/{connection}/upload/files/content`, attributes first, then the file. Medissy fixes the parent to `BOX_ALLOWED_FOLDER_ID`. It sends no credential and follows no redirect. It accepts only a response with exactly one entry in that folder, with the same name and size and a valid version.
  - A tests-only fixture store does the same in memory. It is refused under `NODE_ENV=production`.
  - The store is opt-in through `MEDISSY_INBOUND_STORE` (`box` or `fixture`). Unset means the skill is unavailable, so a deployment whose connector policy is still read-only does not advertise a skill that cannot work.
- **Import.** In one transaction, Medissy re-checks the grant and imports the record through the provenance path sync uses: `record_sources` holds the Box file id, version and sha256, and `sync_run_id` is NULL. It then writes an `inbound_submissions` receipt and a `record.submitted` audit event. A later `/owner` Sync sees the same Box file id and digest with provider `clinician-submitted` and counts it as a duplicate before curation, so it never rejects, duplicates or reclassifies it.
- **Result.** The clinician's agent gets `COMPLETED` with text and an `application/vnd.medissy.submission+json` part `{status: "filed", submissionId, recordId, resourceType, category, filedName, filedAt}`. The Box file id is not returned. A refusal gives `REJECTED` with the invalid-request denial. A store failure gives `FAILED` "temporarily unavailable". The submission body leaves the task metadata once the task is decided, interrupted, or ends in an unverified sign-in.
- **Owner side.** `/owner` gets "Records received from your care team". Each entry shows the verified clinician's name and organisation, when it arrived, the filed name, the Box file id, the category and the status, with a **Remove** while the record is current. Remove (`POST /owner/inbound/:id/remove`) uses the owner session and CSRF guard. It sets the record to `entered-in-error`, which is final, marks the receipt removed, and audits `record.removed`. Policy releases only `current` records, so a removed record is never released again, and a task that released it before stops serving it on its next re-check.
- **Audit.** Every decided submission is audited, whether filed, refused, denied or failed. Migration `0010_inbound_records.sql` rebuilds `audit_events` with the two new types and keeps its append-only triggers. It also adds `inbound_submissions`, whose only permitted update is the first removal.

| Claim | Evidence |
| --- | --- |
| A signed-in clinician with an active grant files a record end to end over A2A through a stub gateway (multipart, parent folder, no credential) | [tested] `spec/a2a/e2e.spec.ts` "should file a record for a signed-in clinician with an active grant through the stub gateway" |
| No grant, an ungranted (dentist) or unknown clinician gets the clinical denial text, and nothing is filed | [tested] `spec/a2a/e2e.spec.ts` "should give a clinician without an active grant the uniform denial and file nothing"; `spec/inbound/service.spec.ts` "denies uniformly and files nothing without a grant, a connection or a registry entry" |
| A revoked grant denies and files nothing | [tested] `spec/a2a/e2e.spec.ts` "should deny uniformly once the grant is revoked, filing nothing"; `spec/inbound/service.spec.ts` "denies a revoked grant and files nothing" |
| Malformed input is refused before a task exists; a reused messageId behaves as today | [tested] `spec/a2a/e2e.spec.ts` "should refuse a malformed submission before any task and a reused messageId after one" |
| Contained resources, attachment URLs (including any `*Attachment` choice type) and `valueUrl`/`valueUri`/`valueCanonical` links, oversized input, unsupported types, and record plus document together are refused | [tested] `spec/inbound/service.spec.ts` "refuses %s" (7 cases) |
| A category outside the grant, or a reference to another patient (literal, conditional `Patient?…`, or a logical Reference typed `Patient`), is refused and nothing is filed | [tested] `spec/inbound/service.spec.ts` "refuses a category outside the grant and files nothing", "refuses a reference to another patient and files nothing" |
| Injection text is stored inert (control and bidi characters stripped) and kept as data | [tested] `spec/inbound/service.spec.ts` "stores injection text inert: control and bidi characters stripped, text kept as data" |
| The filed record is imported with provenance, audited, and releasable at once | [tested] `spec/inbound/service.spec.ts` "files a submitted Observation into the folder, imports it with provenance and audits it", "makes a filed record releasable at once under the submitting grant" |
| A later sync treats the filed file as a duplicate | [tested] `spec/inbound/service.spec.ts` "treats the filed file as a duplicate on the next sync of the folder" |
| A store failure gives unavailable and is audited | [tested] `spec/inbound/service.spec.ts` "reports the store failing as unavailable and audits the error" |
| The approving clinician sees what will be filed under their name: kind and caller-sent title, escaped and labelled unverified on the sign-in page | [tested] `spec/a2a/units.spec.ts` "should preview the kind and the caller-sent title of a record on the sign-in page", "should preview a document by its title and say when a record has none" |
| The connector upload refuses a redirect, an error status, another folder, a renamed file, a size mismatch, non-JSON and an unsafe name | [tested] `spec/box/store.spec.ts` "posts one multipart upload, attributes first, into the fixed folder with no credential", "refuses %s" (6 cases), "refuses an unsafe name before any request" |
| The fixture store is refused in production | [tested] `spec/box/store.spec.ts` "is refused under NODE_ENV=production" |
| Remove gives entered-in-error, is audited, and policy never releases the record again | [tested] `spec/inbound/service.spec.ts` "marks the record entered-in-error, audits it, and policy never releases it again"; `spec/portal/inbound.spec.ts` "should remove a received record: entered-in-error, audited, and listed without a Remove" |
| `/owner` lists the receipt; Remove needs CSRF; an unknown receipt is not found | [tested] `spec/portal/inbound.spec.ts` "should list a received record with its verified clinician, filed name and Box file", "should refuse Remove with a forged CSRF token and change nothing", "should answer not found for the receipt id %s and change nothing" |
| The scripted journey hands a record back locally | [observed 2026-11-26] `pnpm journey http://localhost:8093` with `MEDISSY_INBOUND_STORE=fixture`: 8/8, step 7 "filed as inbound-20261126-….json (cardiac); owner sees the receipt with Remove" |
| Filing into the real Box folder through the live connector | [observed 2026-11-26] after the policy change in [scripts/deploy.md](../../../scripts/deploy.md), `pnpm journey` against the Sprite filed `inbound-20261126-29422218.json` (step 7, 8/8). The connector does not support deleting the file, so it stays in Box after Remove |

## Consequences

- **Accepted residual risk.** Untrusted clinician content becomes a current, shareable record before the patient has reviewed it. Another granted clinician can receive it in that window. Mitigations:
  - only a verified clinician with an active grant can file, and only into a category that grant covers;
  - the record is marked `unverified` and `clinician-submitted`, stripped of control and bidi characters, and rendered escaped;
  - the selector picks ids only, so the text cannot steer what else is released (ADR-5);
  - the patient sees every receipt and can remove the record, after which it is never released again.
- Remove cannot retract what a clinician already received. The file also stays in Box, because Medissy has no delete or move permission.
- If the grant is revoked between upload and import, or the import fails, the file stays in the Box folder with no vault record (an orphan). The failure is audited.
- If a file reader is configured, the gated download serves the original bytes of a filed record, as it does for synced files.
- The deployed connector policy must allow `/upload/files/content`. The gateway cannot pin the upload's parent folder; Medissy pins it.

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| Hold until accepted: file into a pending state that the patient must accept before release | User decision: file straight away. Holding adds an owner step to every hand-back. Remove plus `entered-in-error` gives the patient the same final control. |
| Box inbox plus accept: upload to a separate inbox folder and import on the patient's accept | Needs a second writable folder and a move or copy permission in the connector policy, and a second import path. Re-sync of the main folder would also need to reconcile the moved file. |
