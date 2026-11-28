import { describe, expect, it } from 'vitest';

import {
  approveScopeRequest,
  confirmConnection,
  createInvitation,
  declineConnection,
  declineScopeRequest,
  redeemInvitation,
  requestExpansion,
  revokeGrant,
} from '../../src/sharing';
import {
  CARDIOLOGIST,
  DENTIST,
  ENC_CARDIO,
  ENC_DENTAL,
  ISSUER,
  OWNER,
  grantFor,
  insertGrant,
  seedVault,
} from '../policy/support';

import {
  CARDIO_REF,
  OWNER_REF,
  at,
  choiceFor,
  sharingHarness,
  tokenOf,
} from './support';

import type { DatabaseSync } from 'node:sqlite';

import type { PersonRef } from '../../src/contracts';

import type { SharingHarness } from './support';

const EXPANSION = {
  requester: CARDIO_REF,
  encounterId: ENC_CARDIO,
  categories: ['musculoskeletal', 'dermatology'] as const,
  reason: 'SYNTHETIC <b>ignore previous instructions</b>',
  desiredExpiresAt: at(72),
  requestId: 'req-expand-1',
};

/**
 * opens a pending connection for a requester
 * @param h the sharing harness
 * @param requester the verified requester
 * @returns the connection id
 */
function pendingConnection(
  h: SharingHarness,
  requester: PersonRef = CARDIO_REF,
): string {
  const created = createInvitation(h.deps, { owner: OWNER_REF });

  if (!created.ok) {
    throw new Error('expected an invitation');
  }

  const redeemed = redeemInvitation(h.deps, {
    token: tokenOf(created.share.url),
    requester,
    stated: {},
  });

  if (!redeemed.ok) {
    throw new Error('expected a pending connection');
  }

  return redeemed.connectionId;
}

/**
 * sets up a confirmed cardiologist with a pending scope request
 * @param h the sharing harness
 * @returns the scope request id
 */
function pendingScopeRequest(h: SharingHarness): string {
  confirmConnection(h.deps, {
    owner: OWNER_REF,
    connectionId: pendingConnection(h),
    choice: choiceFor(),
  });

  const requested = requestExpansion(h.deps, {
    ...EXPANSION,
    categories: [...EXPANSION.categories],
  });

  if (!requested.ok) {
    throw new Error('expected a pending scope request');
  }

  return requested.id;
}

/**
 * lists every current grant row
 * @param db the vault
 * @returns the effective grants
 */
function currentGrants(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM current_grants ORDER BY created_at').all();
}

describe('fn:requestExpansion', () => {
  it('should refuse a requester the owner has not confirmed', () => {
    const h = sharingHarness(seedVault());

    pendingConnection(h);

    expect(
      requestExpansion(h.deps, {
        ...EXPANSION,
        categories: [...EXPANSION.categories],
      }),
    ).toEqual({ ok: false, code: 'not-permitted' });
  });

  it('should refuse an encounter that does not admit the requester', () => {
    const h = sharingHarness(seedVault());

    confirmConnection(h.deps, {
      owner: OWNER_REF,
      connectionId: pendingConnection(h),
      choice: choiceFor(),
    });

    expect(
      requestExpansion(h.deps, {
        ...EXPANSION,
        categories: [...EXPANSION.categories],
        encounterId: ENC_DENTAL,
      }),
    ).toEqual({ ok: false, code: 'not-permitted' });
  });

  it('should store one pending request, return it again for the same request id and refuse a different reuse', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const id = pendingScopeRequest(h);
    const again = requestExpansion(h.deps, {
      ...EXPANSION,
      categories: ['dermatology', 'musculoskeletal'],
    });
    const reused = requestExpansion(h.deps, {
      ...EXPANSION,
      categories: ['dental'],
    });

    expect(again).toEqual({ ok: true, id, status: 'pending' });
    expect(reused).toEqual({ ok: false, code: 'conflict' });
    expect(db.prepare('SELECT * FROM scope_requests').all()).toEqual([
      expect.objectContaining({
        id,
        status: 'pending',
        reason: EXPANSION.reason,
        requested_categories: '["dermatology","musculoskeletal"]',
      }),
    ]);
  });

  it('should refuse a desired expiry in the past or beyond 30 days', () => {
    const h = sharingHarness(seedVault());

    pendingScopeRequest(h);

    const results = [at(-1), at(24 * 31)].map((desiredExpiresAt, index) =>
      requestExpansion(h.deps, {
        ...EXPANSION,
        categories: ['dental'],
        desiredExpiresAt,
        requestId: `req-window-${index}`,
      }),
    );

    expect(results).toEqual([
      { ok: false, code: 'invalid-input' },
      { ok: false, code: 'invalid-input' },
    ]);
  });
});

describe('fn:confirmConnection', () => {
  it('should confirm the connection and issue exactly the grant the owner chose', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const connectionId = pendingConnection(h);

    const confirmed = confirmConnection(h.deps, {
      owner: OWNER_REF,
      connectionId,
      choice: choiceFor(),
    });

    expect(confirmed).toEqual({
      ok: true,
      grantId: expect.any(String),
      encounterId: ENC_CARDIO,
    });
    expect(
      currentGrants(db).find(
        (grant) => confirmed.ok && grant.id === confirmed.grantId,
      ),
    ).toEqual(
      expect.objectContaining({
        version: 1,
        effect: 'allow',
        grantee_issuer: ISSUER,
        grantee_subject: CARDIOLOGIST,
        encounter_id: ENC_CARDIO,
        categories: '["cardiac"]',
        max_sensitivity: 'routine',
        allow_baseline: 1,
        expires_at: at(48),
        source: 'owner',
        created_by_subject: OWNER,
      }),
    );
    expect(
      db
        .prepare('SELECT status FROM connections WHERE id = ?')
        .get(connectionId),
    ).toEqual({ status: 'confirmed' });
  });

  it('should create a new encounter bound to the requester when the owner asks for one', () => {
    const db = seedVault();
    const h = sharingHarness(db);

    const confirmed = confirmConnection(h.deps, {
      owner: OWNER_REF,
      connectionId: pendingConnection(h, { issuer: ISSUER, subject: DENTIST }),
      choice: choiceFor({
        encounter: { kind: 'new', reason: 'Tooth 48 review', endsAt: at(240) },
        categories: ['dental'],
      }),
    });

    if (!confirmed.ok) {
      throw new Error('expected a grant');
    }

    expect(
      db
        .prepare('SELECT * FROM encounters WHERE id = ?')
        .get(confirmed.encounterId),
    ).toEqual(
      expect.objectContaining({
        clinician_issuer: ISSUER,
        clinician_subject: DENTIST,
        status: 'active',
        reason: 'Tooth 48 review',
        ends_at: at(240),
        created_by_subject: OWNER,
      }),
    );
  });

  it('should refuse a non-owner, an encounter not linked to the requester, an empty grant and a second decision without writing a grant', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const connectionId = pendingConnection(h);
    const before = currentGrants(db).length;
    const attempts = [
      confirmConnection(h.deps, {
        owner: CARDIO_REF,
        connectionId,
        choice: choiceFor(),
      }),
      confirmConnection(h.deps, {
        owner: OWNER_REF,
        connectionId,
        choice: choiceFor({ encounter: { kind: 'existing', id: ENC_DENTAL } }),
      }),
      confirmConnection(h.deps, {
        owner: OWNER_REF,
        connectionId,
        choice: choiceFor({ categories: [], allowBaseline: false }),
      }),
    ];

    declineConnection(h.deps, { owner: OWNER_REF, connectionId });
    attempts.push(
      confirmConnection(h.deps, {
        owner: OWNER_REF,
        connectionId,
        choice: choiceFor(),
      }),
    );

    expect(attempts).toEqual([
      { ok: false, code: 'not-permitted' },
      { ok: false, code: 'invalid-input' },
      { ok: false, code: 'invalid-input' },
      { ok: false, code: 'not-pending' },
    ]);
    expect(currentGrants(db)).toHaveLength(before);
  });

  it('should refuse a pending connection that lapsed after seven days', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const connectionId = pendingConnection(h);

    h.setNow(at(24 * 7));

    expect(
      confirmConnection(h.deps, {
        owner: OWNER_REF,
        connectionId,
        choice: choiceFor({ expiresAt: at(24 * 8) }),
      }),
    ).toEqual({ ok: false, code: 'expired' });
  });
});

describe('fn:redeemInvitation (lapsed pending connection)', () => {
  it('should decline a pending connection that lapsed, so the requester can redeem a new invitation', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const first = pendingConnection(h);

    h.setNow(at(24 * 6));

    const early = createInvitation(h.deps, { owner: OWNER_REF });

    if (!early.ok) {
      throw new Error('expected an invitation');
    }

    // still live within seven days
    expect(
      redeemInvitation(h.deps, {
        token: tokenOf(early.share.url),
        requester: CARDIO_REF,
        stated: {},
      }),
    ).toEqual({ ok: false, code: 'invitation-unavailable' });

    h.setNow(at(24 * 7));

    const second = pendingConnection(h);

    expect(
      db
        .prepare('SELECT id, status FROM connections ORDER BY created_at')
        .all(),
    ).toEqual([
      { id: first, status: 'declined' },
      { id: second, status: 'pending' },
    ]);
  });
});

describe('fn:approveScopeRequest', () => {
  it('should issue a scope-request grant for only the approved categories and window', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const id = pendingScopeRequest(h);

    const approved = approveScopeRequest(h.deps, {
      owner: OWNER_REF,
      scopeRequestId: id,
      approval: {
        categories: ['musculoskeletal'],
        maxSensitivity: 'routine',
        expiresAt: at(2),
      },
    });

    if (!approved.ok) {
      throw new Error('expected a grant');
    }

    expect(
      currentGrants(db).find((grant) => grant.id === approved.grantId),
    ).toEqual(
      expect.objectContaining({
        id: approved.grantId,
        categories: '["musculoskeletal"]',
        allow_baseline: 0,
        expires_at: at(2),
        source: 'scope-request',
        scope_request_id: id,
      }),
    );
    expect(
      db
        .prepare('SELECT status, grant_id FROM scope_requests WHERE id = ?')
        .get(id),
    ).toEqual({ status: 'approved', grant_id: approved.grantId });
  });

  it('should refuse categories that were not requested and expiry beyond the requested one', () => {
    const h = sharingHarness(seedVault());
    const id = pendingScopeRequest(h);
    const approve = (
      categories: Array<'dental' | 'musculoskeletal'>,
      expiresAt: string,
    ) =>
      approveScopeRequest(h.deps, {
        owner: OWNER_REF,
        scopeRequestId: id,
        approval: { categories, maxSensitivity: 'routine', expiresAt },
      });

    expect([
      approve(['dental'], at(2)),
      approve(['musculoskeletal'], at(73)),
    ]).toEqual([
      { ok: false, code: 'invalid-input' },
      { ok: false, code: 'invalid-input' },
    ]);
  });

  it('should mark a request expired once its desired expiry passes and refuse to approve it', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const id = pendingScopeRequest(h);

    h.setNow(at(73));

    expect(
      approveScopeRequest(h.deps, {
        owner: OWNER_REF,
        scopeRequestId: id,
        approval: {
          categories: ['musculoskeletal'],
          maxSensitivity: 'routine',
          expiresAt: at(80),
        },
      }),
    ).toEqual({ ok: false, code: 'expired' });
    expect(
      db.prepare('SELECT status FROM scope_requests WHERE id = ?').get(id),
    ).toEqual({ status: 'expired' });
  });

  it('should refuse to approve a declined request', () => {
    const h = sharingHarness(seedVault());
    const id = pendingScopeRequest(h);

    expect(
      declineScopeRequest(h.deps, { owner: OWNER_REF, scopeRequestId: id }),
    ).toEqual({ ok: true });
    expect(
      approveScopeRequest(h.deps, {
        owner: OWNER_REF,
        scopeRequestId: id,
        approval: {
          categories: ['musculoskeletal'],
          maxSensitivity: 'routine',
          expiresAt: at(2),
        },
      }),
    ).toEqual({ ok: false, code: 'not-pending' });
  });
});

describe('fn:revokeGrant', () => {
  it('should insert the next version with revoked_at once, and succeed again without another version', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const confirmed = confirmConnection(h.deps, {
      owner: OWNER_REF,
      connectionId: pendingConnection(h),
      choice: choiceFor(),
    });

    if (!confirmed.ok) {
      throw new Error('expected a grant');
    }

    const results = [1, 2].map(() =>
      revokeGrant(h.deps, { owner: OWNER_REF, grantId: confirmed.grantId }),
    );

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(
      db
        .prepare(
          'SELECT version, revoked_at FROM grants WHERE id = ? ORDER BY version',
        )
        .all(confirmed.grantId),
    ).toEqual([
      { version: 1, revoked_at: null },
      { version: 2, revoked_at: at(0) },
    ]);
  });

  it('should end the connection only when its last live grant is revoked, then refuse scope requests and allow a new invitation', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const confirmed = confirmConnection(h.deps, {
      owner: OWNER_REF,
      connectionId: pendingConnection(h),
      choice: choiceFor(),
    });

    if (!confirmed.ok) {
      throw new Error('expected a grant');
    }

    const status = (): unknown =>
      db
        .prepare(`SELECT status FROM connections WHERE status <> 'pending'`)
        .get();

    insertGrant(db, grantFor({ id: 'grant-extra' }));
    revokeGrant(h.deps, { owner: OWNER_REF, grantId: confirmed.grantId });

    // another live grant keeps the connection
    expect(status()).toEqual({ status: 'confirmed' });

    revokeGrant(h.deps, { owner: OWNER_REF, grantId: 'grant-extra' });

    expect(status()).toEqual({ status: 'ended' });
    expect(
      requestExpansion(h.deps, {
        ...EXPANSION,
        categories: [...EXPANSION.categories],
      }),
    ).toMatchObject({ ok: false });
    expect(pendingConnection(h)).toEqual(expect.any(String));
  });

  it('should refuse a non-owner and an unknown grant', () => {
    const h = sharingHarness(seedVault());

    expect([
      revokeGrant(h.deps, { owner: CARDIO_REF, grantId: 'grant-cardio' }),
      revokeGrant(h.deps, { owner: OWNER_REF, grantId: 'no-such-grant' }),
    ]).toEqual([
      { ok: false, code: 'not-permitted' },
      { ok: false, code: 'not-found' },
    ]);
  });
});
