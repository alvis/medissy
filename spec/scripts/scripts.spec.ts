import { describe, expect, it } from 'vitest';

import { checkVaultPath, confirms, vaultFiles } from '../../scripts/cleanup';
import {
  encounterOptions,
  findActiveGrant,
  findPendingConnection,
  releasedRecordIds,
} from '../../scripts/journey';
import {
  mergeEnvText,
  parseCommonArgs,
  parseOrigin,
  personaPassphrase,
} from '../../scripts/lib/env';
import {
  formatStep,
  parseForms,
  parseSetCookie,
  Redactor,
  StepRunner,
} from '../../scripts/lib/support';
import { demoIssuerFor, recordSourceFrom, seedVault } from '../../scripts/seed';
import {
  boxConfigured,
  boxSecretNames,
  forwardedHostVerdict,
  median,
} from '../../scripts/smoke';
import { openVault } from '../../src/vault/migrate';

const SUBJECT = 'synthetic-clinician-ada-northgate';
const SECRET = 'test-only-cardiologist-pass';

describe('scripts/lib/env', () => {
  it('should fill only unset variables from an env file', () => {
    const env: Record<string, string | undefined> = { A: 'shell' };

    expect(mergeEnvText(env, 'A=file\nB=file\n')).toEqual(['B']);
    expect(env).toEqual({ A: 'shell', B: 'file' });
  });

  it('should split --env-file off the arguments in both spellings', () => {
    expect(
      parseCommonArgs(['http://x', '--env-file', 'a.env', '--yes']),
    ).toEqual({
      envFile: { path: 'a.env', explicit: true },
      rest: ['http://x', '--yes'],
    });
    expect(parseCommonArgs(['--', '--env-file=b.env']).envFile).toEqual({
      path: 'b.env',
      explicit: true,
    });
    expect(parseCommonArgs([]).envFile).toEqual({
      path: '.env.local',
      explicit: false,
    });
  });

  it('should refuse missing, hashed or short passphrases by name without echoing the value', () => {
    const errorOf = (env: Record<string, string>): string => {
      try {
        personaPassphrase(env, 'unknown-clinician');

        return '';
      } catch (error) {
        return (error as Error).message;
      }
    };

    expect(errorOf({})).toContain(
      'DEMO_IDP_SECRET_UNKNOWN_CLINICIAN is not set',
    );
    expect(
      errorOf({ DEMO_IDP_SECRET_UNKNOWN_CLINICIAN: 'scrypt$a$b' }),
    ).toContain('holds a hash');
    expect(
      errorOf({ DEMO_IDP_SECRET_UNKNOWN_CLINICIAN: 'short-value' }),
    ).not.toContain('short-value');
    expect(
      personaPassphrase(
        { DEMO_IDP_SECRET_CARDIOLOGIST: SECRET },
        'cardiologist',
      ),
    ).toBe(SECRET);
  });

  it('should reduce an origin argument to scheme, host and port', () => {
    expect(parseOrigin('https://medissy-x.sprites.app/a2a/v1')).toBe(
      'https://medissy-x.sprites.app',
    );
    expect(() => parseOrigin('ftp://x')).toThrow('origin');
    expect(() => parseOrigin(undefined)).toThrow('origin');
  });
});

describe('scripts/lib/support', () => {
  it('should redact every registered secret, longest first, and ignore tiny values', () => {
    const redactor = new Redactor();

    redactor.add(SECRET, 'test-only', 'ab', undefined);

    expect(redactor.scrub(`x ${SECRET} y test-only ab`)).toBe(
      'x [redacted] y [redacted] ab',
    );
  });

  it('should print a redacted detail, and mark later steps NOT RUN after a failure', async () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    let clock = 0;
    const runner = new StepRunner(
      redactor,
      (line) => lines.push(line),
      () => (clock += 500),
    );

    redactor.add(SECRET);
    await runner.step(
      { id: '1', title: 'fails', acceptance: ['A02'] },
      async () => {
        throw new Error(`bad ${SECRET}`);
      },
    );
    await runner.step(
      { id: '2', title: 'skipped', acceptance: ['A03'] },
      async () => 'never',
    );
    await runner.step(
      { id: '3', title: 'independent', acceptance: ['A13'] },
      async () => 'ok',
      { independent: true },
    );

    expect(lines).toEqual([
      'FAIL     1 fails [A02] 0.5 s :: bad [redacted]',
      'NOT RUN  2 skipped [A03] :: an earlier step failed',
      'PASS     3 independent [A13] 0.5 s :: ok',
    ]);
    expect(runner.failed).toBe(true);
    expect(
      formatStep({
        id: 'S5',
        title: 't',
        acceptance: ['A13'],
        status: 'MEASURED',
      }),
    ).toBe('MEASURED S5 t [A13]');
  });

  it('should parse forms with hidden fields and every named control', () => {
    const [form] = parseForms(
      '<form method="post" action="/owner/confirm/c-1"><input type="hidden" name="_csrf" value="a&amp;b"><input type="radio" name="encounter" value="new"><select name="validityHours"></select></form>',
    );

    expect(form).toMatchObject({
      action: '/owner/confirm/c-1',
      hidden: { _csrf: 'a&b' },
      names: ['_csrf', 'encounter', 'validityHours'],
    });
  });

  it('should read cookie updates and recognise cleared cookies', () => {
    expect(parseSetCookie('sid=abc; Path=/; HttpOnly')).toEqual({
      name: 'sid',
      value: 'abc',
      cleared: false,
    });
    expect(parseSetCookie('sid=; Max-Age=0')?.cleared).toBe(true);
    expect(
      parseSetCookie('sid=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT')?.cleared,
    ).toBe(true);
    expect(parseSetCookie('garbage')).toBeUndefined();
  });
});

describe('scripts/journey parsers', () => {
  const dashboard = [
    '<section><div class="card"><p><strong>Connection request</strong> from other-subject</p><a href="/owner/confirm/c-other">r</a></div>',
    `<div class="card"><p><strong>Connection request</strong> from ${SUBJECT} · <strong>lapsed</strong></p><a href="/owner/confirm/c-old">r</a></div>`,
    `<div class="card"><p><strong>Connection request</strong> from ${SUBJECT}</p><a href="/owner/confirm/c-1">r</a></div>`,
    `<div class="card"><p><strong>allow</strong> ${SUBJECT} · encounter enc-1 · version 1</p><p><strong>active</strong></p><form method="post" action="/owner/grants/g-1/revoke"></form></div>`,
    `<div class="card"><p><strong>allow</strong> ${SUBJECT} · encounter enc-0 · version 2</p><p><strong>revoked 2026-11-25</strong></p></div></section>`,
  ].join('');

  it('should find the live pending connection and the active grant of one requester', () => {
    expect(findPendingConnection(dashboard, SUBJECT)).toBe('c-1');
    expect(findPendingConnection(dashboard, 'nobody')).toBeUndefined();
    expect(findActiveGrant(dashboard, SUBJECT)).toEqual({
      grantId: 'g-1',
      encounterId: 'enc-1',
    });
  });

  it('should list the encounter options and the released record ids', () => {
    expect(
      encounterOptions(
        '<select name="encounterId"><option value="enc-1">a</option><option value="enc-2">b</option></select>',
      ),
    ).toEqual(['enc-1', 'enc-2']);
    expect(
      releasedRecordIds({
        state: 'completed',
        text: '',
        data: [
          {
            data: {
              e: [
                { recordId: 'rec-1' },
                { recordId: 'rec-1' },
                { recordId: 'rec-2' },
              ],
            },
          },
        ],
      }),
    ).toEqual(['rec-1', 'rec-2']);
  });
});

describe('scripts/seed', () => {
  it('should derive the demo issuer exactly as the provider does', () => {
    expect(demoIssuerFor('https://m.sprites.app/')).toEqual({
      issuer: 'https://m.sprites.app/demo-idp',
      audience: 'https://m.sprites.app',
    });
  });

  it('should default records to fixture, or none in production, and refuse unknown values', () => {
    expect(recordSourceFrom([], {})).toBe('fixture');
    expect(recordSourceFrom([], { NODE_ENV: 'production' })).toBe('none');
    expect(recordSourceFrom(['--records', 'none'], {})).toBe('none');
    expect(() => recordSourceFrom(['--records', 'box'], {})).toThrow(
      '--records',
    );
  });

  it('should seed the patient, trust and fixture records once, and find only duplicates on a rerun', async () => {
    const db = openVault(':memory:');
    const options = {
      publicUrl: 'http://localhost:8080',
      records: 'fixture' as const,
    };
    const first = await seedVault(db, options);
    const second = await seedVault(db, options);
    const count = (sql: string): number => Number(db.prepare(sql).get()?.n);

    expect(first).toMatchObject({
      patient: 'created',
      records: { source: 'fixture' },
    });
    expect(first.records).toMatchObject({ imported: expect.any(Number) });
    expect(
      first.records.source === 'fixture' && first.records.imported,
    ).toBeGreaterThan(0);
    expect(second).toMatchObject({
      patient: 'existing',
      records: { imported: 0 },
    });
    expect(first.records.source === 'fixture' && first.records.rejected).toBe(
      first.records.source === 'fixture' && first.records.expectedRejected,
    );
    expect(count('SELECT COUNT(*) AS n FROM patient')).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM trusted_issuers WHERE issuer = 'http://localhost:8080/demo-idp'",
      ),
    ).toBe(1);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM sync_runs WHERE adapter = 'fixture' AND trigger = 'seed'",
      ),
    ).toBe(2);

    await expect(
      seedVault(db, {
        publicUrl: 'https://elsewhere.example',
        records: 'none',
      }),
    ).rejects.toThrow('pnpm cleanup');
    db.close();
  });
});

describe('scripts/cleanup and scripts/smoke', () => {
  it('should only ever delete a .sqlite vault and its journal files, after the exact confirm word', () => {
    expect(vaultFiles('data/m.sqlite')).toEqual([
      'data/m.sqlite',
      'data/m.sqlite-wal',
      'data/m.sqlite-shm',
      'data/m.sqlite-journal',
    ]);
    expect(() => checkVaultPath(':memory:')).toThrow('.sqlite');
    expect(() => checkVaultPath('/etc/passwd')).toThrow('.sqlite');
    expect(confirms(' reset\n')).toBe(true);
    expect(confirms('yes')).toBe(false);
  });

  it('should interpret proxy trust, timings and Box settings without values', () => {
    expect(forwardedHostVerdict(421, true)).toContain('TRUST_PROXY=1');
    expect(forwardedHostVerdict(200, false)).toContain('TRUST_PROXY=0');
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20])).toBe(15);
    expect(
      boxConfigured({
        BOX_GATEWAY_CONNECTION_ID: 'replace-me',
        BOX_ALLOWED_FOLDER_ID: '1',
      }),
    ).toBe(false);
    expect(
      boxConfigured({
        BOX_GATEWAY_CONNECTION_ID: 'c',
        BOX_ALLOWED_FOLDER_ID: '1',
      }),
    ).toBe(true);
    expect(
      boxSecretNames({ BOX_CLIENT_SECRET: 'x', BOX_ALLOWED_FOLDER_ID: '1' }),
    ).toEqual(['BOX_CLIENT_SECRET']);
  });
});
