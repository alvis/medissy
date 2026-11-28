# ADR-8: Explicit `node:sqlite` migrations with invariants enforced by DB triggers

- Status: `Accepted`
- Date: `2026-11-25`
- Sources: brief §2 ("SQLite with explicit migrations … Do not assume Prisma is required"); plan rejected alternatives

## Context

The vault holds grants, records, receipts and task bindings. Their invariants must hold even when application code is wrong:

- grants are append-only;
- receipts are immutable;
- a task binds once;
- an invitation is consumed once.

Node 24 ships `node:sqlite` (SQLite 3.54.1, unflagged; [INTEGRATION.md](../../INTEGRATION.md#pinned-versions)).

## Decision

- Plain SQL files `migrations/0001`–`0010` are applied by `src/vault/migrate.ts` (`openVault`) through `node:sqlite`. There is no ORM.
- The migrator:
  - records each migration with a checksum;
  - refuses an edited migration, a gap in the numbering, a misnamed file and a database newer than the code;
  - rolls a failing migration back completely;
  - turns on foreign keys.
- Invariants live in the schema, as `CHECK` constraints and triggers. For example: `grants_no_update`, `grants_revoked_is_final`, `receipts_no_update`, `receipt_records_grant_is_live`, `a2a_tasks_binding_is_locked`, `invitations_terminal_is_final` and `connections_decision_is_final`. The table list is in the [architecture data model](../README.md#data-model).

| Claim | Evidence |
| --- | --- |
| Checksums, idempotence, rollback, gaps and newer-DB refusal | [tested] `spec/vault/migrate.spec.ts` "records each migration once with its checksum and is idempotent", "rejects an applied migration whose file was edited", "rolls back a failing migration completely", "rejects a gap in the numbering", "rejects a database that is newer than the code" |
| Append-only tables block UPDATE, DELETE and REPLACE | [tested] `spec/vault/migrate.spec.ts` "blocks UPDATE", "blocks DELETE of one row and of the whole table", "blocks REPLACE over an existing id, with or without recursive triggers" |
| The file DB reopens without reapplying migrations | [tested] `spec/vault/migrate.spec.ts` "persists to a file database and reopens without reapplying" |

## Consequences

- A bug in application code cannot rewrite a grant or a receipt. The write fails instead.
- The schema changes only by appending a new migration. Migrations 0008 (`receipts.request_digest`) and 0009 (`trusted_issuers` kinds, ADR-9) are examples. 0009 also supersedes the 0001 comment on `clinicians`, which cannot be edited because its checksum is recorded.

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| Prisma or another ORM | Extra dependency and code generation. Weak trigger support (brief §2). |
| `better-sqlite3` | A native add-on. `node:sqlite` is built in. |
