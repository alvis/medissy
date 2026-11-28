# ADR-1: One Sprite, one Node 24 Fastify process, in-process vault

- Status: `Accepted`
- Date: `2026-11-25`
- Sources: discovery ledger int-7; brief §2, §3.1

## Context

Medissy is the patient's own AI agent. It has to stay reachable while the patient is offline, keep its policy, records and audit trail between requests, and wake when a request arrives. The deadline is four days. The brief asks for "one service on the Sprite and a test identity provider", with no multi-service framework.

## Decision

- One Fly Sprite, named `medissy`, runs one Node 24 process (`engines.node >=24`) that serves everything over Fastify 5: the A2A agent, the two synthetic issuers `/demo-idp` and `/institution-idp` (ADR-9), the portals and Box sync.
- `src/server.ts` (`createFromEnv`) opens the SQLite vault once (`DATABASE_PATH`, through `openVault`) and passes it to each feature setup: identity and the two synthetic issuers, then A2A, then the portal. The vault closes when the app closes.
- `TRUST_PROXY=1` trusts `X-Forwarded-*` from exactly one hop, the Sprite's TLS proxy. Medissy refuses to boot when `MEDISSY_PUBLIC_URL` is https and `TRUST_PROXY` is not `1` ([tested] `spec/server-env.spec.ts`). Any `Host` other than `MEDISSY_PUBLIC_URL`'s gets `421`, except `/healthz`.

| Claim | Evidence |
| --- | --- |
| One vault reaches every setup and closes with the app | [tested] `spec/server.spec.ts` "passes the one vault to every setup and closes it with the app" |
| Exactly one proxy hop is trusted | [tested] `spec/server.spec.ts` "trusts exactly one proxy hop for the client address" |
| Foreign hosts get 421 | [tested] `spec/server.spec.ts` "answers 421 for a host other than the public one, except health checks" |
| Runs on the Sprite, wakes after idle, keeps SQLite across suspend | NOT RUN (SPK01, A13; waits on DEP01) |

## Consequences

- There is one deployable artifact and one trust domain. The synthetic issuers' signing keys and the vault share a disk, so ADR-3 encrypts the key at rest with `DEMO_IDP_KEY_ENCRYPTION_KEY`, which is required when the public URL is https.
- In-process state (rate-limit counters, the per-task poll lock) resets on restart. Durable state (tasks, sign-ins, receipts) lives in SQLite.
- Wake latency is measured, never promised. There is no SLA claim.

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| A separate issuer Sprite | User decision int-7: one Sprite. |
| A multi-service framework | Brief §2. One process is enough for one patient. |
| A hosted database | The vault belongs to the patient's Sprite. `node:sqlite` needs no extra service (ADR-8). |
