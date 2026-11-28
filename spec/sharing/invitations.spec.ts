import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import jsQR from 'jsqr';
import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';

import { createInvitation, redeemInvitation } from '../../src/sharing';
import { openVault } from '../../src/vault/migrate';
import { renderQrSvg } from '../../src/widgets';
import {
  CARDIOLOGIST,
  DENTIST,
  ISSUER,
  OWNER,
  PATIENT,
  T_SEED,
  personFor,
  seedVault,
} from '../policy/support';

import {
  CARDIO_REF,
  ORIGIN,
  OWNER_REF,
  at,
  sharingHarness,
  tokenOf,
} from './support';

const STATED = {
  name: 'SYNTHETIC <script>alert(1)</script> Dr Ada',
  organization: 'Northgate "Cardiology"',
  role: 'cardiologist',
};

/**
 * rasterises a uqr SVG path back into its module grid
 * @param svg markup from renderQrSvg
 * @returns the dark modules as a boolean grid
 */
function rasterise(svg: string): boolean[][] {
  const pixel = 10;
  const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1]) / pixel;
  const grid = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
  const path = /<path fill="black" d="([^"]*)"/.exec(svg)?.[1] ?? '';

  for (const square of path.matchAll(/M(\d+),(\d+)h10v10h-10z/g)) {
    const row = grid[Number(square[2]) / pixel];

    if (row) {
      row[Number(square[1]) / pixel] = true;
    }
  }

  return grid;
}

/**
 * paints a module grid as an RGBA bitmap with a white quiet zone
 * @param grid the dark modules
 * @param scale pixels per module
 * @param quiet quiet-zone width in modules
 * @returns the bitmap and its side length
 */
function bitmap(
  grid: boolean[][],
  scale = 4,
  quiet = 4,
): { data: Uint8ClampedArray; side: number } {
  const side = (grid.length + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);

  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const dark =
        grid[Math.floor(y / scale) - quiet]?.[Math.floor(x / scale) - quiet] ??
        false;

      if (dark) {
        data.fill(0, (y * side + x) * 4, (y * side + x) * 4 + 3);
      }
    }
  }

  return { data, side };
}

describe('fn:createInvitation', () => {
  it('should store only the SHA-256 of a 32-byte token and return a /connect fragment URL', () => {
    const db = seedVault();
    const { deps } = sharingHarness(db);

    const created = createInvitation(deps, { owner: OWNER_REF, label: 'GP' });

    expect(created.ok).toBe(true);

    if (!created.ok) {
      return;
    }

    const token = tokenOf(created.share.url);
    const rows = db.prepare('SELECT * FROM invitations').all();

    expect(created.share).toEqual({
      kind: 'share-invitation',
      url: `${ORIGIN}/connect#${token}`,
      expiresAt: at(24),
    });
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(rows).toEqual([
      expect.objectContaining({
        id: created.id,
        patient_id: PATIENT,
        token_hash: createHash('sha256').update(token).digest('hex'),
        label: 'GP',
        status: 'open',
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('should refuse anyone but the patient owner', () => {
    const { deps } = sharingHarness(seedVault());

    expect(createInvitation(deps, { owner: CARDIO_REF })).toEqual({
      ok: false,
      code: 'not-permitted',
    });
  });

  it('should render a QR that an independent decoder reads back as the /connect#token URL', () => {
    const { deps } = sharingHarness(seedVault());
    const created = createInvitation(deps, { owner: OWNER_REF });

    if (!created.ok) {
      throw new Error('expected an invitation');
    }

    const expected = encode(created.share.url, { border: 1 }).data;
    const grid = rasterise(renderQrSvg(created.share.url));
    const { data, side } = bitmap(grid);
    const decoded = jsQR(data, side, side);

    expect(grid).toEqual(expected);
    expect(decoded?.data).toBe(created.share.url);
    expect(decoded?.data).toMatch(
      new RegExp(`^${ORIGIN}/connect#[A-Za-z0-9_-]{43}$`),
    );
  });
});

describe('fn:redeemInvitation', () => {
  it('should consume the invitation once and open one pending connection with the stated labels stored as untrusted text', () => {
    const db = seedVault();
    const { deps } = sharingHarness(db);
    const created = createInvitation(deps, { owner: OWNER_REF });

    if (!created.ok) {
      throw new Error('expected an invitation');
    }

    const token = tokenOf(created.share.url);
    const first = redeemInvitation(deps, {
      token,
      requester: CARDIO_REF,
      stated: STATED,
    });
    const second = redeemInvitation(deps, {
      token,
      requester: personFor(DENTIST),
      stated: {},
    });

    expect(first).toEqual({
      ok: true,
      connectionId: expect.any(String),
      status: 'pending',
    });
    expect(second).toEqual({ ok: false, code: 'invitation-unavailable' });
    expect(db.prepare('SELECT * FROM connections').all()).toEqual([
      expect.objectContaining({
        invitation_id: created.id,
        requester_issuer: ISSUER,
        requester_subject: CARDIOLOGIST,
        stated_name: STATED.name,
        stated_organization: STATED.organization,
        stated_role: STATED.role,
        status: 'pending',
      }),
    ]);
  });

  it('should give one generic denial for unknown, malformed, expired, revoked and self-redeemed tokens', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const expiring = createInvitation(h.deps, { owner: OWNER_REF });
    const revoked = createInvitation(h.deps, { owner: OWNER_REF });
    const own = createInvitation(h.deps, { owner: OWNER_REF });

    if (!expiring.ok || !revoked.ok || !own.ok) {
      throw new Error('expected invitations');
    }

    db.prepare("UPDATE invitations SET status = 'revoked' WHERE id = ?").run(
      revoked.id,
    );
    h.setNow(at(25));

    const attempts = [
      { token: 'A'.repeat(43), requester: CARDIO_REF },
      { token: 'not a token', requester: CARDIO_REF },
      { token: tokenOf(expiring.share.url), requester: CARDIO_REF },
      { token: tokenOf(revoked.share.url), requester: CARDIO_REF },
      { token: tokenOf(own.share.url), requester: personFor(OWNER) },
    ].map((input) => redeemInvitation(h.deps, { ...input, stated: {} }));

    expect(attempts).toEqual(
      Array.from({ length: 5 }, () => ({
        ok: false,
        code: 'invitation-unavailable',
      })),
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM connections').get()).toEqual({
      n: 0,
    });
  });

  it('should let only the first of two redemptions on separate database connections succeed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'medissy-shr-'));
    const path = join(dir, 'vault.sqlite');

    try {
      const a = openVault(path, { now: () => new Date(T_SEED) });

      a.prepare(
        `INSERT INTO patient (id, label, owner_issuer, owner_subject, created_at) VALUES (?, 'SYNTHETIC patient', ?, ?, ?)`,
      ).run(PATIENT, ISSUER, OWNER, T_SEED);

      const b = openVault(path, { now: () => new Date(T_SEED) });
      const created = createInvitation(sharingHarness(a).deps, {
        owner: OWNER_REF,
      });

      if (!created.ok) {
        throw new Error('expected an invitation');
      }

      const token = tokenOf(created.share.url);
      const results = [
        redeemInvitation(sharingHarness(a).deps, {
          token,
          requester: CARDIO_REF,
          stated: {},
        }),
        redeemInvitation(sharingHarness(b).deps, {
          token,
          requester: personFor(DENTIST),
          stated: {},
        }),
      ];

      expect(results.map((result) => result.ok)).toEqual([true, false]);
      expect(b.prepare('SELECT COUNT(*) AS n FROM connections').get()).toEqual({
        n: 1,
      });

      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should keep a consumed invitation frozen by the database trigger', () => {
    const db = seedVault();
    const { deps } = sharingHarness(db);
    const created = createInvitation(deps, { owner: OWNER_REF });

    if (!created.ok) {
      throw new Error('expected an invitation');
    }

    redeemInvitation(deps, {
      token: tokenOf(created.share.url),
      requester: CARDIO_REF,
      stated: {},
    });

    expect(() =>
      db
        .prepare(
          "UPDATE invitations SET status = 'open', consumed_at = NULL, consumed_by_issuer = NULL, consumed_by_subject = NULL WHERE id = ?",
        )
        .run(created.id),
    ).toThrow(/cannot change/);
  });

  it('should never log, audit or store the raw token', () => {
    const db = seedVault();
    const h = sharingHarness(db);
    const created = createInvitation(h.deps, { owner: OWNER_REF });

    if (!created.ok) {
      throw new Error('expected an invitation');
    }

    const token = tokenOf(created.share.url);

    redeemInvitation(h.deps, { token, requester: CARDIO_REF, stated: {} });
    redeemInvitation(h.deps, { token, requester: CARDIO_REF, stated: {} });

    expect(h.log.mock.calls).toEqual([
      [{ event: 'invitation.created', outcome: 'success' }],
      [{ event: 'invitation.redeemed', outcome: 'success' }],
      [{ event: 'invitation.redeemed', outcome: 'denied' }],
    ]);

    const stored = JSON.stringify([
      db.prepare('SELECT * FROM invitations').all(),
      db.prepare('SELECT * FROM connections').all(),
      db.prepare('SELECT * FROM audit_events').all(),
    ]);

    expect(stored).not.toContain(token);
  });
});
