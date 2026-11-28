import { afterEach, describe, expect, it } from 'vitest';

import { createSqliteAdapter } from '../../src/demo-idp/adapter';
import { createDemoIdentity } from '../../src/demo-idp/compose';
import { loadOrCreateSigningKey } from '../../src/demo-idp/keys';
import {
  deviceConfirmPage,
  escapeHtml,
  loginPage,
} from '../../src/demo-idp/pages';
import { ensureDemoTrust } from '../../src/demo-idp/seed';
import { createApp } from '../../src/server';
import { openVault } from '../../src/vault/migrate';
import {
  Browser,
  createHarness,
  formAction,
  hiddenFields,
  insertTask,
  pathOf,
  PUBLIC_URL,
  startSignIn,
  TEST_KEK,
  TEST_PASSPHRASES,
  vaultWithPatient,
} from '../identity/support';

import type { Harness } from '../identity/support';

const ISSUER = `${PUBLIC_URL}/demo-idp`;

describe('demo IdP at /demo-idp', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
  });

  it('publishes discovery with the device flow, ES256 and the sub-path issuer', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({
      method: 'GET',
      url: '/demo-idp/.well-known/openid-configuration',
      headers: { host: 'medissy.test' },
    });
    const discovery = res.json<Record<string, unknown>>();

    expect(res.statusCode).toBe(200);
    expect(discovery.issuer).toBe(ISSUER);
    expect(discovery.device_authorization_endpoint).toBe(
      `${ISSUER}/device/auth`,
    );
    expect(discovery.grant_types_supported).toContain(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    expect(discovery.id_token_signing_alg_values_supported).toEqual(['ES256']);
    expect(discovery.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('serves only the public half of its signing key', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({
      method: 'GET',
      url: '/demo-idp/jwks',
      headers: { host: 'medissy.test' },
    });
    const { keys } = res.json<{ keys: Array<Record<string, unknown>> }>();

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
    expect(keys[0]).not.toHaveProperty('d');
  });

  it('refuses a device authorization for another resource', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/demo-idp/device/auth',
      headers: {
        'host': 'medissy.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        client_id: 'medissy-agent',
        scope: 'openid medissy:request',
        resource: 'https://other-service.example',
      }).toString(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_target' });
  });

  it('labels its pages as a synthetic demo and forbids scripts and framing', async () => {
    harness = await createHarness();
    const { started } = await startSignIn(harness);
    const login = await new Browser(harness.app).openDeviceLogin(
      started.userCode,
    );

    expect(login.statusCode).toBe(200);
    expect(login.body).toContain(
      'SYNTHETIC Northgate Health — not a real hospital sign-in',
    );
    expect(login.body).not.toContain('<script');

    // the patient's issuer carries its own SYNTHETIC banner
    const owner = await new Browser(harness.app).follow(
      await new Browser(harness.app).request('GET', '/auth/owner/sign-in'),
    );

    expect(owner.body).toContain(
      'SYNTHETIC DEMO — not a real identity provider',
    );
    expect(login.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'",
    );
    expect(login.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });

  it('rejects an account choice without a CSRF token', async () => {
    harness = await createHarness();
    const { started } = await startSignIn(harness);
    const browser = new Browser(harness.app);
    const login = await browser.openDeviceLogin(started.userCode);
    const res = await browser.request('POST', formAction(login.body), {
      account: 'cardiologist',
      passphrase: TEST_PASSPHRASES.cardiologist ?? '',
    });

    expect(res.statusCode).toBe(403);
  });

  it('rejects a CSRF token minted for another interaction', async () => {
    harness = await createHarness();
    const browser = new Browser(harness.app);
    const first = await browser.openDeviceLogin(
      (await startSignIn(harness)).started.userCode,
    );
    const second = await browser.openDeviceLogin(
      (await startSignIn(harness)).started.userCode,
    );
    const res = await browser.request('POST', formAction(second.body), {
      _csrf: hiddenFields(first.body)._csrf ?? '',
      account: 'cardiologist',
      passphrase: TEST_PASSPHRASES.cardiologist ?? '',
    });

    expect(res.statusCode).toBe(403);
  });

  it('refuses an account that is not one of the synthetic users', async () => {
    harness = await createHarness();
    const browser = new Browser(harness.app);
    const login = await browser.openDeviceLogin(
      (await startSignIn(harness)).started.userCode,
    );
    const res = await browser.request('POST', formAction(login.body), {
      _csrf: hiddenFields(login.body)._csrf ?? '',
      passphrase: TEST_PASSPHRASES.cardiologist ?? '',
      account: 'real-person',
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('do not match');
  });

  it('shows an error page for an interaction this browser does not hold', async () => {
    harness = await createHarness();
    const res = await new Browser(harness.app).request(
      'GET',
      '/demo-idp/interaction/not-a-real-uid',
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Sign-in expired');
  });

  it('keeps provider state in the vault idp_store', async () => {
    harness = await createHarness();
    await startSignIn(harness);

    const models = harness.db
      .prepare('SELECT DISTINCT model FROM idp_store ORDER BY model')
      .all()
      .map((row) => String(row.model));

    expect(models).toEqual(['DeviceCode', 'MedissySigningKey']);
  });
});

describe('fn:loadOrCreateSigningKey', () => {
  it('creates a key once and reuses it on the next start', async () => {
    const db = openVault(':memory:');
    const first = await loadOrCreateSigningKey(db, { kek: TEST_KEK });
    const second = await loadOrCreateSigningKey(db, { kek: TEST_KEK });

    expect(second.privateJwk).toEqual(first.privateJwk);
    expect(first.publicJwk).not.toHaveProperty('d');
    expect(first.publicJwk.kid).toBe(first.privateJwk.kid);
  });
});

describe('fn:createSqliteAdapter', () => {
  it('finds by id, uid and user code, consumes, expires and revokes by grant', async () => {
    const db = openVault(':memory:');
    let at = Date.parse('2026-11-25T12:00:00.000Z');
    const adapter = createSqliteAdapter(db, () => new Date(at));
    const deviceCodes = adapter('DeviceCode');
    const sessions = adapter('Session');

    await deviceCodes.upsert('d1', { userCode: 'ABCD', grantId: 'g1' }, 60);
    await sessions.upsert('s1', { uid: 'u1' }, undefined);

    expect(await deviceCodes.find('d1')).toEqual({
      userCode: 'ABCD',
      grantId: 'g1',
    });
    expect(await deviceCodes.findByUserCode('ABCD')).toMatchObject({
      grantId: 'g1',
    });
    expect(await sessions.findByUid('u1')).toEqual({ uid: 'u1' });

    await deviceCodes.consume('d1');
    expect(await deviceCodes.find('d1')).toHaveProperty('consumed');

    at += 61_000;
    expect(await deviceCodes.find('d1')).toBeUndefined();

    await deviceCodes.upsert('d2', { grantId: 'g2' }, 60);
    await deviceCodes.revokeByGrantId('g2');
    expect(await deviceCodes.find('d2')).toBeUndefined();

    await sessions.destroy('s1');
    expect(await sessions.find('s1')).toBeUndefined();
  });
});

describe('demo IdP pages', () => {
  it('escapes markup in every dynamic value', () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe(
      '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;',
    );

    const confirm = deviceConfirmPage({
      label: 'SYNTHETIC <label>',
      providerForm: '',
      clientName: '<img src=x onerror=alert(1)>',
      userCode: '<b>',
      context: {
        taskDigest: 'ABCD-EF01-2345',
        encounterLabel: '<i>enc</i>',
        question: '<a href=//evil.example>q</a>',
      },
    });

    expect(confirm).not.toContain('<img');
    expect(confirm).not.toContain('<b>');
    expect(confirm).not.toContain('<i>');
    expect(confirm).not.toContain('<a href');

    const login = loginPage({
      label: 'SYNTHETIC <label>',
      action: '/a"><script>',
      abortAction: '/b',
      csrfToken: '"><script>',
      clientName: '<script>alert(1)</script>',
      users: [
        {
          key: 'k"><script>',
          subject: 's',
          displayName: '<script>',
          description: '<script>',
          allowedScopes: [],
        },
      ],
    });

    expect(login).not.toContain('<script');
  });
});

describe('demo IdP hardening (fix pass)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
  });

  it('shows the requesting task on the confirm page, escaped', async () => {
    harness = await createHarness();
    const taskId = insertTask(harness.db);
    const started = await harness.demo.deviceFlow.start({
      taskId,
      encounterLabel: 'Cardiology review <b>3 Dec</b> (SYNTHETIC)',
      question: 'Prior ECG? <img src=x onerror=alert(1)>',
    });
    const confirm = await new Browser(harness.app).enterUserCode(
      started.userCode,
    );

    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain(started.taskDigest);
    expect(confirm.body).toContain(
      'Cardiology review &lt;b&gt;3 Dec&lt;/b&gt; (SYNTHETIC)',
    );
    expect(confirm.body).toContain('Prior ECG? &lt;img src=x');
    expect(confirm.body).not.toContain('<img');
  });

  it('refuses a device authorization from the agent client without task context', async () => {
    harness = await createHarness();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/demo-idp/device/auth',
      headers: {
        'host': 'medissy.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        client_id: 'medissy-agent',
        scope: 'openid medissy:request',
        resource: PUBLIC_URL,
      }).toString(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('refuses a correct passphrase used for another persona', async () => {
    harness = await createHarness();
    const browser = new Browser(harness.app);
    const login = await browser.openDeviceLogin(
      (await startSignIn(harness)).started.userCode,
    );
    const res = await browser.chooseAccount(
      login,
      'owner',
      TEST_PASSPHRASES.cardiologist,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('Sign-in complete');
  });

  it('disables a persona that has no passphrase configured', async () => {
    harness = await createHarness({
      passphrases: { ...TEST_PASSPHRASES, cardiologist: undefined },
    });
    const browser = new Browser(harness.app);
    const login = await browser.openDeviceLogin(
      (await startSignIn(harness)).started.userCode,
    );

    expect(
      (await browser.chooseAccount(login, 'cardiologist', '')).statusCode,
    ).toBe(401);
  });

  it('rate-limits user-code guessing per client IP', async () => {
    harness = await createHarness();
    const browser = new Browser(harness.app);
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const input = await browser.request('GET', '/demo-idp/device');

      statuses.push(input.statusCode);

      if (input.statusCode === 200) {
        const res = await browser.request('POST', formAction(input.body), {
          ...hiddenFields(input.body),
          user_code: `BCDF-GH${String(attempt).padStart(2, '0')}`,
        });

        statuses.push(res.statusCode);
      }
    }

    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(
      0,
    );
    expect(statuses.slice(0, 30).every((status) => status !== 429)).toBe(true);

    harness.clock.advance(61);
    expect((await browser.request('GET', '/demo-idp/device')).statusCode).toBe(
      200,
    );
  });

  it('pins forwarded headers: Secure IdP cookies for an https origin, 421 for a foreign host', async () => {
    const db = vaultWithPatient();
    const demo = await createDemoIdentity({
      db,
      publicUrl: 'https://medissy.test',
      passphrases: TEST_PASSPHRASES,
      cookieKeys: ['test-only-cookie-key'],
      keyEncryptionKey: TEST_KEK,
    });
    const app = await createApp({
      trustProxy: true,
      allowedHosts: ['medissy.test'],
      setup: demo.setup,
    });

    try {
      // the proxy terminated TLS but sent no X-Forwarded-Proto
      const plain = await app.inject({
        method: 'GET',
        url: '/demo-idp/device',
        headers: { host: 'medissy.test' },
      });
      const sessionCookies = [plain.headers['set-cookie']]
        .flat()
        .filter((cookie): cookie is string => typeof cookie === 'string')
        .filter((cookie) => cookie.startsWith('_session'));

      expect(plain.statusCode).toBe(200);
      expect(sessionCookies.length).toBeGreaterThan(0);
      expect(sessionCookies.every((cookie) => /;\s*secure/i.test(cookie))).toBe(
        true,
      );
      expect(plain.body).toContain(
        'action="https://medissy.test/demo-idp/device',
      );

      const forged = await app.inject({
        method: 'GET',
        url: '/demo-idp/device',
        headers: { 'host': 'medissy.test', 'x-forwarded-host': 'evil.example' },
      });

      expect(forged.statusCode).toBe(421);
      expect(forged.body).not.toContain('evil.example');

      const health = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { host: 'internal-health' },
      });

      expect(health.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('fn:loadOrCreateSigningKey (encryption at rest)', () => {
  /**
   * reads the stored key row
   * @param db the vault
   * @returns its payload
   */
  const storedKey = (db: ReturnType<typeof openVault>): string =>
    String(
      (
        db
          .prepare(
            "SELECT payload FROM idp_store WHERE model = 'MedissySigningKey'",
          )
          .get() as { payload: string }
      ).payload,
    );

  it('stores only ciphertext and refuses to start with the wrong key', async () => {
    const db = openVault(':memory:');
    const { privateJwk } = await loadOrCreateSigningKey(db, { kek: TEST_KEK });

    expect(storedKey(db)).not.toContain(String(privateJwk.d));
    expect(JSON.parse(storedKey(db))).toMatchObject({ enc: 'A256GCM' });
    await expect(
      loadOrCreateSigningKey(db, { kek: Buffer.alloc(32, 9) }),
    ).rejects.toThrow();
    await expect(loadOrCreateSigningKey(db)).rejects.toThrow(
      /DEMO_IDP_KEY_ENCRYPTION_KEY/,
    );
  });

  it('seals a plaintext key left by an earlier start once a key is configured', async () => {
    const db = openVault(':memory:');
    const plain = await loadOrCreateSigningKey(db);

    expect(storedKey(db)).toContain(String(plain.privateJwk.d));

    const sealed = await loadOrCreateSigningKey(db, { kek: TEST_KEK });

    expect(sealed.privateJwk).toEqual(plain.privateJwk);
    expect(storedKey(db)).not.toContain(String(plain.privateJwk.d));
  });
});

describe('fn:createSqliteAdapter (consumed)', () => {
  it('keeps a consumed artifact consumed when the provider saves it again', async () => {
    const adapter = createSqliteAdapter(openVault(':memory:'))('DeviceCode');

    await adapter.upsert('d1', { userCode: 'ABCD' }, 60);
    await adapter.consume('d1');
    await adapter.upsert('d1', { userCode: 'ABCD', accountId: 'x' }, 60);

    expect(await adapter.find('d1')).toMatchObject({
      accountId: 'x',
      consumed: expect.any(Number),
    });
  });
});

describe('fn:ensureDemoTrust', () => {
  it('disables synthetic issuers left over from an earlier public URL, keeping one institution enabled', () => {
    const db = openVault(':memory:');

    ensureDemoTrust(db, { publicUrl: 'https://old.example' });
    ensureDemoTrust(db, { publicUrl: PUBLIC_URL });

    expect(
      db
        .prepare(
          'SELECT issuer, kind, enabled FROM trusted_issuers ORDER BY issuer',
        )
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([
      { issuer: `${PUBLIC_URL}/demo-idp`, kind: 'patient', enabled: 1 },
      {
        issuer: `${PUBLIC_URL}/institution-idp`,
        kind: 'institution',
        enabled: 1,
      },
      { issuer: 'https://old.example/demo-idp', kind: 'patient', enabled: 0 },
      {
        issuer: 'https://old.example/institution-idp',
        kind: 'institution',
        enabled: 0,
      },
    ]);
  });

  it('configures the institution with its organisation, role claim and allowed roles, and seeds no clinician', () => {
    const db = openVault(':memory:');

    ensureDemoTrust(db, { publicUrl: PUBLIC_URL });

    expect({
      ...db
        .prepare(
          `SELECT organization_id, organization_name, role_claim, allowed_roles
           FROM trusted_issuers WHERE kind = 'institution'`,
        )
        .get(),
    }).toEqual({
      organization_id: 'org-northgate-health',
      organization_name: 'Northgate Health (SYNTHETIC)',
      role_claim: 'roles',
      allowed_roles: '["cardiologist","dentist"]',
    });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM clinicians').get(),
    ).toMatchObject({ n: 0 });
  });
});

describe('demo IdP passphrase guessing and shared buckets (re-check)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
  });

  it('locks only the guessing client out of a persona after 5 wrong passphrases, never the doctor signing in from elsewhere', async () => {
    harness = await createHarness();
    const attacker = new Browser(harness.app, '198.51.100.7');
    let page = await attacker.openDeviceLogin(
      (await startSignIn(harness)).started.userCode,
    );
    const statuses: number[] = [];

    for (let guess = 0; guess < 6; guess += 1) {
      page = await attacker.chooseAccount(
        page,
        'cardiologist',
        `wrong-guess-${guess}-xxxx`,
      );
      statuses.push(page.statusCode);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    expect(page.body).toContain('locked');

    // the cardiologist, from another IP, signs in to the portal as usual
    const doctor = new Browser(harness.app, '203.0.113.20');
    const signedIn = await doctor.signIn('clinician', 'cardiologist');

    expect(pathOf(String(signedIn.headers.location))).toMatch(/^\/clinician/);

    // the guessing client stays locked, even with the right passphrase
    const still = await attacker.chooseAccount(
      await attacker.openDeviceLogin(
        (await startSignIn(harness)).started.userCode,
      ),
      'cardiologist',
    );

    expect(still.statusCode).toBe(429);
    expect(still.headers['retry-after']).toBeDefined();

    harness.clock.advance(901);

    const later = await attacker.chooseAccount(
      await attacker.openDeviceLogin(
        (await startSignIn(harness)).started.userCode,
      ),
      'cardiologist',
    );

    expect(later.body).toContain('Sign-in complete');
  });

  it('locks only the guessing client out of the owner at /demo-idp, never the patient signing in to revoke', async () => {
    harness = await createHarness();
    const attacker = new Browser(harness.app, '198.51.100.9');
    let page = await attacker.follow(
      await attacker.request('GET', '/auth/owner/sign-in'),
    );

    expect(formAction(page.body)).toMatch(/^\/demo-idp\//);

    const statuses: number[] = [];

    for (let guess = 0; guess < 6; guess += 1) {
      page = await attacker.chooseAccount(
        page,
        'owner',
        `wrong-guess-${guess}-xxxx`,
      );
      statuses.push(page.statusCode);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);

    // the patient, from another IP, still reaches the owner portal
    const patient = new Browser(harness.app, '203.0.113.21');
    const signedIn = await patient.signIn('owner', 'owner');

    expect(pathOf(String(signedIn.headers.location))).toBe('/portal');
  });

  it('rate-limits passphrase POSTs per IP before any passphrase is checked', async () => {
    harness = await createHarness();
    const browser = new Browser(harness.app, '198.51.100.8');
    let page = await browser.openDeviceLogin(
      (await startSignIn(harness)).started.userCode,
    );
    const action = formAction(page.body);
    const statuses: number[] = [];

    for (let guess = 0; guess < 11; guess += 1) {
      const res = await browser.request('POST', action, {
        _csrf: hiddenFields(page.body)._csrf ?? '',
        account: 'real-person',
        passphrase: `guess-${guess}-xxxxxxxx`,
      });

      statuses.push(res.statusCode);
      page = res.statusCode === 401 ? res : page;
    }

    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('rate-limits new authorization requests per IP', async () => {
    harness = await createHarness();
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 31; attempt += 1) {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/demo-idp/auth?client_id=medissy-portal&state=s${attempt}`,
        remoteAddress: '198.51.100.9',
        headers: { host: 'medissy.test' },
      });

      statuses.push(res.statusCode);
    }

    expect(statuses.slice(0, 30).includes(429)).toBe(false);
    expect(statuses[30]).toBe(429);
  });

  it('tells the clinician the task details are unverified and to compare the task code', async () => {
    harness = await createHarness();
    const { started } = await startSignIn(harness);
    const confirm = await new Browser(harness.app).enterUserCode(
      started.userCode,
    );

    expect(confirm.body).toContain('Sent by the requesting agent (unverified)');
    expect(confirm.body).toContain('compare its task code');
    expect(confirm.body).toContain(started.taskDigest);
  });

  it('warns plainly that the result goes to the agent that showed the code', async () => {
    harness = await createHarness();
    const { started } = await startSignIn(harness);
    const confirm = await new Browser(harness.app).enterUserCode(
      started.userCode,
    );

    expect(confirm.body).toContain(
      'The result goes to the agent that showed you this code. Only continue if you started this request.',
    );
  });

  it("keeps Medissy's own issuer calls out of the per-IP buckets, but not a forged marker", async () => {
    const db = vaultWithPatient();
    const demo = await createDemoIdentity({
      db,
      publicUrl: PUBLIC_URL,
      passphrases: TEST_PASSPHRASES,
      cookieKeys: ['test-only-cookie-key'],
      keyEncryptionKey: TEST_KEK,
    });
    const app = await createApp({
      allowedHosts: ['medissy.test'],
      setup: demo.setup,
    });

    try {
      for (let start = 0; start < 35; start += 1) {
        const started = await demo.deviceFlow.start({
          taskId: insertTask(db),
          encounterLabel: 'Cardiology review (SYNTHETIC)',
          question: 'Any prior cardiac findings?',
        });

        expect(started.userCode).toBeTruthy();
      }

      const statuses: number[] = [];

      for (let attempt = 0; attempt < 31; attempt += 1) {
        const res = await app.inject({
          method: 'GET',
          url: '/demo-idp/device',
          headers: { 'host': 'medissy.test', 'x-medissy-internal': 'forged' },
        });

        statuses.push(res.statusCode);
      }

      expect(statuses.slice(0, 30).includes(429)).toBe(false);
      expect(statuses[30]).toBe(429);
    } finally {
      await app.close();
    }
  });
});
