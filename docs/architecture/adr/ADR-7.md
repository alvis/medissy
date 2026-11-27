# ADR-7: Sharing is a single-use QR invitation, and only a step-up confirm page creates grants

- Status: `Accepted`
- Date: `2026-11-25`
- Sources: discovery ledger D2, D3, int-3; brief §8

## Context

The patient asks their agent for a code to share with their care team (int-3). Whoever scans the code is not yet trusted. A grant created from chat could be forged by prompt injection (D3). Brief §8 forbids "implicit approval from chat or widget JS".

## Decision

1. **Invitation.** The owner gets a share code: over A2A after owner sign-in (`medissy:owner`), or with `POST /owner/invitations`. It is the address plus a single-use token in a URL fragment (`/connect#<token>`). Only the SHA-256 of the 32-byte token is stored (`invitations.token_hash`), and the token expires after 24 h. The QR is SVG.
2. **Redemption.** The clinician's agent sends `redeem-invitation`. The clinician signs in in-task (ADR-4), and the invitation is consumed once. Redemption opens one **pending** connection and shares nothing. `/connect` offers the same redemption in a browser.
3. **Confirmation.** The patient opens `/owner/confirm/:id`. Signing in for it forces a fresh login (`prompt=login`, `max_age=0`), and the confirm `POST` is accepted only when the verified ID token's `auth_time` is at most 5 minutes old. **Only this POST creates a grant**, with the categories, encounter and window the patient chose. Decline is `POST /owner/confirm/:id/decline`.
4. **Lifecycle.** Connection statuses are `pending`, `confirmed`, `declined` and `ended` (a DB `CHECK`).
   - A pending connection lapses after 7 days and can no longer be confirmed.
   - Revoking (`POST /owner/grants/:id/revoke`) appends the next grant version with `revoked_at`; grants are append-only by trigger. The next poll of any task under that grant gets no artifacts.
   - Revoking a clinician's last live grant moves their connection from `confirmed` to `ended`. After that, a scope request from them gets 403, and only a new invitation reconnects them.
   - Expanded-scope requests (`POST /clinician/scope-requests`) are inert until the patient approves them on the same confirm page.

| Claim | Evidence |
| --- | --- |
| Only the hash is stored; the link is a fragment | [tested] `spec/sharing/invitations.spec.ts` "should store only the SHA-256 of a 32-byte token and return a /connect fragment URL" |
| Single use under a race | [tested] `spec/sharing/invitations.spec.ts` "should let only the first of two redemptions on separate database connections succeed" |
| One generic denial | [tested] `spec/sharing/invitations.spec.ts` "should give one generic denial for unknown, malformed, expired, revoked and self-redeemed tokens" |
| The decoded QR is the `/connect#token` URL | [tested] `spec/sharing/invitations.spec.ts` "should render a QR that an independent decoder reads back as the /connect#token URL" |
| A share code over A2A, redeemed pending | [tested] `spec/a2a/e2e.spec.ts` "should give the signed-in patient owner a single-use QR over A2A that a clinician then redeems, pending patient confirmation" |
| Step-up | [tested] `spec/portal/step-up.spec.ts` "should ask the issuer for a fresh login with prompt=login and max_age=0, and keep the verified auth_time", "should not let an existing issuer session satisfy step-up without the passphrase" |
| A lapsed pending connection is refused | [tested] `spec/sharing/decisions.spec.ts` "should refuse a pending connection that lapsed after seven days" |
| A07: pending, approved, declined, expired, revoked | [tested] `spec/sharing/a07.spec.ts` (5 cases) |
| Revoking the last live grant ends the connection; a scope request then gets 403; a new invitation reconnects | [tested] `spec/sharing/decisions.spec.ts` "should end the connection only when its last live grant is revoked, then refuse scope requests and allow a new invitation"; `spec/portal/clinician.spec.ts` "should end the connection with its last grant: a scope request is then refused (403), and a new invitation reconnects" |
| Through OpenClaw desktop, scanning a real QR | NOT RUN (DEP01, A12) |

## Consequences

- No chat message or widget button can create a grant. Approval needs the patient's passphrase within the last 5 minutes.
- Revocation stops future release only. It cannot retract what a clinician already received.
- This is a demo authorization flow, not a legally compliant consent system.

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| Approval in chat only | Prompt injection could create a grant (D3). |
| The QR as a bearer credential | The address is only a locator (brief §5). Redemption gives a pending state, never access. |
| Storing the raw token | A database read would expose live invitations. |
