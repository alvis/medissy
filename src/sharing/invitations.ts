/**
 * single-use share invitations (decision D2); the QR is the health address
 * plus a single-use invitation: 32 random bytes, base64url, carried in the
 * URL fragment so it never reaches a server log; only its SHA-256 is stored;
 * redeeming it opens a pending connection that only the owner can confirm,
 * on the step-up confirm page; it never releases anything by itself
 */
import { createHash, randomBytes } from 'node:crypto';

import { LIMITS } from '../contracts';
import { shareInvitationSchema } from '../widgets/parts';
import { oneLine } from '../widgets/text';

import { declineLapsedConnections } from './queries';
import {
  audit,
  denied,
  immediate,
  isOwner,
  log,
  newId,
  readVaultOwner,
} from './store';

import type { PersonRef } from '../contracts';
import type { ShareInvitation } from '../widgets/parts';

import type { SharingDenial, SharingDeps } from './types';

const TOKEN_BYTES = 32;
/** base64url of 32 bytes, unpadded */
export const INVITATION_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** a stored token hash: lower-case SHA-256 hex */
const TOKEN_HASH_SHAPE = /^[0-9a-f]{64}$/;
const MS_PER_HOUR = 3_600_000;
/** default invitation lifetime */
export const INVITATION_TTL_HOURS = 24;
/** the path an invitation URL opens; the token rides in the fragment */
export const CONNECT_PATH = '/connect';

/** a new invitation: its row id and what the owner shares */
export interface CreatedInvitation {
  ok: true;
  id: string;
  share: ShareInvitation;
}

/** what a requester said about themselves; untrusted, never used in policy */
export interface StatedLabels {
  name?: string;
  organization?: string;
  role?: string;
}

/** a redemption that opened a pending connection */
export interface RedeemedInvitation {
  ok: true;
  connectionId: string;
  status: 'pending';
}

/**
 * returns the SHA-256 of an invitation token, as stored
 * @param token the raw token
 * @returns lower-case hex digest
 */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * returns the configured origin that invitation URLs hang off
 * @param publicOrigin the configured public origin
 * @returns the bare http(s) origin
 * @throws {Error} when the configuration is not an http(s) origin
 */
function originOf(publicOrigin: string): string {
  const url = new URL(publicOrigin);

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('the public origin must be an http(s) URL');
  }

  return url.origin;
}

/**
 * issues a single-use invitation for the verified owner
 * @param deps the vault, clock and configured origin
 * @param input the verified owner and an optional private label
 * @param input.owner the verified owner (must be the vault owner)
 * @param input.label a short owner-facing label
 * @returns the invitation, or `not-permitted` for anyone but the owner
 */
export function createInvitation(
  deps: SharingDeps,
  input: { owner: PersonRef; label?: string },
): CreatedInvitation | SharingDenial {
  const vault = readVaultOwner(deps.db);

  if (!vault || !isOwner(vault, input.owner)) {
    return denied('not-permitted');
  }

  const origin = originOf(deps.publicOrigin);
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const now = deps.clock();
  const expiresAt = new Date(
    now.getTime() + INVITATION_TTL_HOURS * MS_PER_HOUR,
  ).toISOString();
  const id = newId(deps);
  const label = input.label ? oneLine(input.label, LIMITS.label) : '';

  immediate(deps.db, () => {
    deps.db
      .prepare(
        `INSERT INTO invitations (id, patient_id, token_hash, label, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        id,
        vault.patientId,
        hashInvitationToken(token),
        label || null,
        now.toISOString(),
        expiresAt,
      );
    audit(deps, {
      type: 'invitation.created',
      outcome: 'success',
      actorKind: 'owner',
      actor: input.owner,
      patientId: vault.patientId,
      target: { type: 'invitation', id },
      details: { expiresAt },
    });
  });
  log(deps, { event: 'invitation.created', outcome: 'success' });

  return {
    ok: true,
    id,
    share: shareInvitationSchema.parse({
      kind: 'share-invitation',
      url: `${origin}${CONNECT_PATH}#${token}`,
      expiresAt,
    }),
  };
}

/**
 * cleans one stated label: one line, bounded, empty becomes absent
 * @param value what the requester typed
 * @param max the column bound
 * @returns the cleaned label or null
 */
function statedLabel(value: string | undefined, max: number): string | null {
  const line = value === undefined ? '' : oneLine(value, max);

  return line === '' ? null : line;
}

/**
 * redeems an invitation as a verified requester: consumes it (single use) and
 * opens a pending connection, in one transaction; unknown, malformed,
 * expired, consumed or revoked tokens, a redemption by the owner, and a
 * requester who already has a live connection all get the same denial
 * @param deps the vault and clock
 * @param input the raw token, the verified requester and their stated labels
 * @param input.token the token from the invitation URL's fragment
 * @param input.requester the verified clinician (never from message text)
 * @param input.stated what the requester says about themselves (untrusted)
 * @returns the pending connection, or `invitation-unavailable`
 */
export function redeemInvitation(
  deps: SharingDeps,
  input: { token: string; requester: PersonRef; stated: StatedLabels },
): RedeemedInvitation | SharingDenial {
  return redeemInvitationHash(deps, {
    tokenHash: INVITATION_TOKEN_SHAPE.test(input.token)
      ? hashInvitationToken(input.token)
      : '',
    requester: input.requester,
    stated: input.stated,
  });
}

/**
 * records a denied redemption in the audit log and the operational log
 * @param deps the vault and clock
 * @param refusal the vault, if any, and the requester
 * @param refusal.vault the vault patient and owner, when one exists
 * @param refusal.requester the verified requester
 * @returns the generic denial
 */
function refuseRedemption(
  deps: SharingDeps,
  refusal: {
    vault: ReturnType<typeof readVaultOwner>;
    requester: PersonRef;
  },
): SharingDenial {
  const { vault, requester } = refusal;

  if (vault) {
    immediate(deps.db, () => {
      audit(deps, {
        type: 'invitation.consumed',
        outcome: 'denied',
        actorKind: 'clinician',
        actor: requester,
        patientId: vault.patientId,
      });
    });
  }

  log(deps, { event: 'invitation.redeemed', outcome: 'denied' });

  return denied('invitation-unavailable');
}

/**
 * consumes the invitation and opens the pending connection, in the caller's
 * transaction
 * @param deps the vault and clock
 * @param redemption what is being redeemed, by whom, and the new ids
 * @param redemption.tokenHash the SHA-256 of the invitation token
 * @param redemption.requester the verified clinician
 * @param redemption.stated what the requester says about themselves
 * @param redemption.patientId the vault patient
 * @param redemption.connectionId the id of the connection to open
 * @param redemption.now the current time as an ISO string
 * @returns true when the invitation was open and the connection was created
 */
function consumeInvitation(
  deps: SharingDeps,
  redemption: {
    tokenHash: string;
    requester: PersonRef;
    stated: StatedLabels;
    patientId: string;
    connectionId: string;
    now: string;
  },
): boolean {
  const { tokenHash, requester, stated, patientId, connectionId, now } =
    redemption;

  // a pending connection the owner never decided no longer blocks a new one
  declineLapsedConnections(deps.db, deps.clock());

  const row = deps.db
    .prepare('SELECT id FROM invitations WHERE token_hash = ?')
    .get(tokenHash);
  const invitationId = row ? String(row.id) : undefined;

  // checked before consuming, so a refused requester leaves it open
  if (invitationId === undefined || hasLiveConnection(deps, requester)) {
    return false;
  }

  const consumed = deps.db
    .prepare(
      `UPDATE invitations
       SET status = 'consumed', consumed_at = ?, consumed_by_issuer = ?, consumed_by_subject = ?
       WHERE id = ? AND status = 'open' AND expires_at > ?`,
    )
    .run(now, requester.issuer, requester.subject, invitationId, now);

  if (consumed.changes !== 1) {
    return false;
  }

  deps.db
    .prepare(
      `INSERT INTO connections (id, patient_id, invitation_id, requester_issuer, requester_subject,
         stated_name, stated_organization, stated_role, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      connectionId,
      patientId,
      invitationId,
      requester.issuer,
      requester.subject,
      statedLabel(stated.name, LIMITS.title),
      statedLabel(stated.organization, LIMITS.title),
      statedLabel(stated.role, LIMITS.name),
      now,
    );
  audit(deps, {
    type: 'invitation.consumed',
    outcome: 'success',
    actorKind: 'clinician',
    actor: requester,
    patientId,
    target: { type: 'connection', id: connectionId },
  });

  return true;
}

/**
 * redeems an invitation by its token's SHA-256, for callers that hash the
 * token as soon as it arrives (the A2A task keeps only the hash); same
 * single-use rules and generic denial as `redeemInvitation`
 * @param deps the vault and clock
 * @param input the token hash, the verified requester and their stated labels
 * @param input.tokenHash the SHA-256 of the invitation token
 * @param input.requester the verified clinician (never from message text)
 * @param input.stated what the requester says about themselves (untrusted)
 * @returns the pending connection, or `invitation-unavailable`
 */
export function redeemInvitationHash(
  deps: SharingDeps,
  input: { tokenHash: string; requester: PersonRef; stated: StatedLabels },
): RedeemedInvitation | SharingDenial {
  const vault = readVaultOwner(deps.db);
  const refuse = (): SharingDenial =>
    refuseRedemption(deps, { vault, requester: input.requester });

  if (
    !vault ||
    !TOKEN_HASH_SHAPE.test(input.tokenHash) ||
    isOwner(vault, input.requester)
  ) {
    return refuse();
  }

  const now = deps.clock().toISOString();
  const connectionId = newId(deps);
  const opened = immediate(deps.db, () =>
    consumeInvitation(deps, {
      ...input,
      patientId: vault.patientId,
      connectionId,
      now,
    }),
  );

  if (!opened) {
    return refuse();
  }

  log(deps, { event: 'invitation.redeemed', outcome: 'success' });

  return { ok: true, connectionId, status: 'pending' };
}

/**
 * checks whether the requester already has a pending or confirmed connection
 * @param deps the sharing deps
 * @param requester the verified requester
 * @returns true when a live connection exists
 */
function hasLiveConnection(deps: SharingDeps, requester: PersonRef): boolean {
  return (
    deps.db
      .prepare(
        `SELECT 1 FROM connections WHERE requester_issuer = ? AND requester_subject = ?
           AND status IN ('pending', 'confirmed')`,
      )
      .get(requester.issuer, requester.subject) !== undefined
  );
}
