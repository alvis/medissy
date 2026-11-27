# ADR-2: Box through the Sprites Box connector gateway

- Status: `Accepted`
- Date: `2026-11-25`
- Sources: discovery ledger int-2; brief §3.2, §6

## Context

The synthetic source documents live in a dedicated Box account. The brief forbids Box OAuth credentials inside the Sprite. The Sprites Box connector is approved in the Fly dashboard and reached through a gateway URL, and it is not scoped to a folder (`root_readwrite`). A file download is answered with a redirect to a signed Box download URL.

## Decision

- `src/box/gateway.ts` calls only the connector gateway, for the configured connection and folder (`BOX_GATEWAY_CONNECTION_ID`, `BOX_ALLOWED_FOLDER_ID`). It sends no credential, and ids that could steer the path are refused.
- Listing and metadata calls follow no redirect. A file download follows exactly one, only to a plain https URL on a `boxcloud.com` host, and sends no headers on that hop.
- Responses are size-capped, and a listing is cut at 500 entries and reported as truncated.
- Sync is an explicit action the patient takes (`POST /owner/sync`). There are no webhooks.
- Imports are validated, deduplicated and stamped with provenance in `src/box/sync.ts`. Foreign-patient and mixed-patient files are rejected.
- Clinicians never get a Box link. The gated download `GET /a2a/v1/tasks/:taskId/files/:fileId` serves only `.json` and `.txt`, at most 5 MB, after a fresh grant re-check, as a `no-store` attachment. Every refusal is the same 404.

| Claim | Evidence |
| --- | --- |
| Calls only the gateway for the allowed folder, sends no credential | [tested] `spec/box/connector.spec.ts` "calls only the gateway URL for the allowed folder and sends no credential" |
| Allows one redirect, to an https Box download host, with no headers | [tested] `spec/box/connector.spec.ts` "follows one redirect to an https Box download host with no headers", "refuses a second hop", "refuses any redirect on metadata and listing calls" |
| Responses are capped | [tested] `spec/box/connector.spec.ts` "caps a download by content-length and by streamed bytes" |
| A listing is cut at 500 entries and reported as truncated | [tested] `spec/box/connector.spec.ts` "reports a listing cut at 500 entries as truncated" |
| The gated download serves only `.json`/`.txt`, ≤ 5 MB, `no-store`, after a grant re-check; refusals are one 404 | [tested] `spec/a2a/e2e.spec.ts` "runs SendMessage -> AUTH_REQUIRED -> /institution-idp approval -> GetTask -> COMPLETED with schema-valid parts, then gates downloads" |
| Import is idempotent and keeps provenance | [tested] `spec/box/sync.spec.ts` "is idempotent: a second sync imports nothing and duplicates nothing", "stores provenance: provider, version, digest and verification per file" |
| Real connector I/O from inside the Sprite, with no Box secret in the environment | NOT RUN (SPK03, A01; waits on DEP01 and the Box connector approval) |

## Consequences

- No Box secret exists in the repository, the environment or the Sprite. The connector's account-wide scope is contained by using a Box account that holds only synthetic data.
- Locally, tests use a stub gateway and the fixture adapter. Neither counts as A01 evidence.

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| A Box OAuth app inside the Sprite | The brief forbids Box credentials in the Sprite. |
| Box webhooks | Connector support is unconfirmed. Explicit sync is enough (goal non-goals). |
| Passing signed Box URLs to clients | They bypass Medissy's authorization and audit. |
