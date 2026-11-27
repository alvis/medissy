import { generateKeyPair, importJWK, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateSigningKey } from '../../src/demo-idp/keys';
import {
  DEMO_CARDIOLOGIST,
  DEMO_OWNER,
  INSTITUTION_ISSUER,
  PATIENT_ISSUER,
} from '../../src/demo-idp/users';

import {
  Browser,
  createHarness,
  PUBLIC_URL,
  startSignIn,
  TEST_KEK,
} from './support';

import type { Harness } from './support';

const ISSUER = `${PUBLIC_URL}/institution-idp`;
const PATIENT_ISSUER_URL = `${PUBLIC_URL}/demo-idp`;
const ORG = 'org-northgate-health';
const AGENT = 'medissy-agent';

/** which issuer's key signs a test token */
type KeyOf = 'institution' | 'patient';

/**
 * returns the stored signing key of one synthetic issuer
 * @param harness the app whose vault holds the key
 * @param which institution or patient: whose stored key to load
 * @returns its key pair as JWKs
 */
async function issuerKey(
  harness: Harness,
  which: KeyOf = 'institution',
): ReturnType<typeof loadOrCreateSigningKey> {
  const profile = which === 'institution' ? INSTITUTION_ISSUER : PATIENT_ISSUER;

  return loadOrCreateSigningKey(harness.db, {
    kek: TEST_KEK,
    keyId: profile.signingKeyId,
  });
}

/**
 * runs a real device sign-in at the institution and captures the tokens the
 * server received; only the test's fetch shim sees them
 * @param harness the app the sign-in runs against
 * @param account the account key
 * @returns the access and ID token the server received from the IdP
 */
async function issuedTokens(
  harness: Harness,
  account: string,
): Promise<{ accessToken: string; idToken: string }> {
  await issuedAccessToken(harness, account);

  const response = harness.tokenResponses.at(-1);
  const { access_token: accessToken, id_token: idToken } = response ?? {};

  if (typeof accessToken !== 'string' || typeof idToken !== 'string') {
    throw new Error('no tokens issued');
  }

  return { accessToken, idToken };
}

/**
 * signs an ID token with an issuer's own key
 * @param harness the app whose IdP key signs the token
 * @param claims payload changes
 * @param which the issuer whose key signs it
 * @returns the signed token
 */
async function signIdToken(
  harness: Harness,
  claims: Record<string, unknown> = {},
  which: KeyOf = 'institution',
): Promise<string> {
  const { privateJwk } = await issuerKey(harness, which);
  const key = await importJWK(privateJwk, 'ES256');
  const at = Math.floor(harness.clock.now().getTime() / 1000);

  return new SignJWT({
    iss: which === 'institution' ? ISSUER : PATIENT_ISSUER_URL,
    sub: DEMO_CARDIOLOGIST.subject,
    aud: AGENT,
    name: 'Dr Ada Northgate (SYNTHETIC cardiologist)',
    roles: ['cardiologist'],
    iat: at,
    exp: at + 600,
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES256', kid: privateJwk.kid })
    .sign(key);
}

/**
 * runs a real device sign-in and captures the access token the server received
 * only the test's fetch shim can see it; the helper never returns it
 * @param harness the app the sign-in runs against
 * @param account the account key
 * @returns the access token string the server received from the IdP
 */
async function issuedAccessToken(
  harness: Harness,
  account: string,
): Promise<string> {
  const { taskId, started } = await startSignIn(harness);

  await new Browser(harness.app).approveDevice(started.userCode, account);
  harness.clock.advance(6);
  await harness.demo.deviceFlow.poll(taskId);

  const token = harness.tokenResponses.at(-1)?.access_token;

  if (typeof token !== 'string') {
    throw new Error('no access token issued');
  }

  return token;
}

/**
 * signs a token with the demo IdP's own key, so only the chosen claim is wrong
 * @param harness the app whose IdP key signs the token
 * @param overrides claim and header changes
 * @param overrides.header protected header changes
 * @param overrides.claims payload changes
 * @param overrides.which the issuer whose key signs it (the institution by default)
 * @returns the signed token
 */
async function signWithIdpKey(
  harness: Harness,
  overrides: {
    header?: Record<string, unknown>;
    claims?: Record<string, unknown>;
    which?: KeyOf;
  } = {},
): Promise<string> {
  const { privateJwk } = await issuerKey(harness, overrides.which);
  const key = await importJWK(privateJwk, 'ES256');
  const at = Math.floor(harness.clock.now().getTime() / 1000);

  return new SignJWT({
    iss: overrides.which === 'patient' ? PATIENT_ISSUER_URL : ISSUER,
    sub: DEMO_CARDIOLOGIST.subject,
    aud: PUBLIC_URL,
    scope: 'medissy:request',
    client_id: 'medissy-agent',
    jti: 'jti-1',
    iat: at,
    exp: at + 600,
    ...overrides.claims,
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'at+jwt',
      kid: privateJwk.kid,
      ...overrides.header,
    })
    .sign(key);
}

describe('fn:createAccessTokenVerifier (A02)', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('accepts a real at+jwt as identity only: no organisation, roles or registry entry from an access token alone', async () => {
    const token = await issuedAccessToken(harness, 'cardiologist');
    const result = await harness.demo.verifier.verify(token, 'medissy:request');

    expect(result).toMatchObject({
      ok: true,
      clinician: null,
      principal: {
        issuer: ISSUER,
        subject: DEMO_CARDIOLOGIST.subject,
        audience: [PUBLIC_URL],
        roles: [],
      },
    });
    expect(result.ok && result.principal.organizationId).toBeUndefined();
  });

  it('rejects an ID token used as an access token', async () => {
    const browser = new Browser(harness.app);

    await browser.signIn('owner', 'owner');
    const idToken = harness.tokenResponses.at(-1)?.id_token;

    expect(typeof idToken).toBe('string');
    expect(
      await harness.demo.verifier.verify(String(idToken), 'medissy:owner'),
    ).toEqual({ ok: false, reason: 'wrong-type' });
  });

  it('rejects a tampered signature', async () => {
    const token = await issuedAccessToken(harness, 'cardiologist');
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(
      Buffer.from(payload ?? '', 'base64url').toString(),
    ) as Record<string, unknown>;
    const forged = Buffer.from(
      JSON.stringify({ ...claims, sub: DEMO_OWNER.subject }),
    ).toString('base64url');

    expect(
      await harness.demo.verifier.verify(
        `${header}.${forged}.${signature}`,
        'medissy:request',
      ),
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a token signed by another key under the trusted issuer', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const { privateJwk } = await issuerKey(harness);
    const at = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      scope: 'medissy:request',
      client_id: 'medissy-agent',
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: privateJwk.kid })
      .setIssuer(ISSUER)
      .setAudience(PUBLIC_URL)
      .setSubject(DEMO_CARDIOLOGIST.subject)
      .setJti('x')
      .setIssuedAt(at)
      .setExpirationTime(at + 600)
      .sign(privateKey);

    expect(
      await harness.demo.verifier.verify(token, 'medissy:request'),
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an issuer that is not trusted', async () => {
    const token = await signWithIdpKey(harness, {
      claims: { iss: 'https://evil.example/idp' },
    });

    expect(
      await harness.demo.verifier.verify(token, 'medissy:request'),
    ).toEqual({ ok: false, reason: 'untrusted-issuer' });
  });

  it('rejects a trusted issuer once it is disabled', async () => {
    const token = await issuedAccessToken(harness, 'cardiologist');

    harness.db
      .prepare('UPDATE trusted_issuers SET enabled = 0 WHERE issuer = ?')
      .run(ISSUER);

    expect(
      await harness.demo.verifier.verify(token, 'medissy:request'),
    ).toEqual({ ok: false, reason: 'untrusted-issuer' });
  });

  it('rejects the wrong audience', async () => {
    const token = await signWithIdpKey(harness, {
      claims: { aud: 'https://other-service.example' },
    });

    expect(
      await harness.demo.verifier.verify(token, 'medissy:request'),
    ).toEqual({ ok: false, reason: 'wrong-audience' });
  });

  it('rejects a real token once it has expired', async () => {
    const token = await issuedAccessToken(harness, 'cardiologist');

    harness.clock.advance(601);

    expect(
      await harness.demo.verifier.verify(token, 'medissy:request'),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a real token that lacks the required scope', async () => {
    const token = await issuedAccessToken(harness, 'cardiologist');

    expect(await harness.demo.verifier.verify(token, 'medissy:owner')).toEqual({
      ok: false,
      reason: 'missing-scope',
    });
  });

  it('rejects a token with no scope claim', async () => {
    const token = await signWithIdpKey(harness, {
      claims: { scope: undefined },
    });

    expect(
      await harness.demo.verifier.verify(token, 'medissy:request'),
    ).toEqual({ ok: false, reason: 'missing-scope' });
  });

  it('rejects a plain JWT type header', async () => {
    const token = await signWithIdpKey(harness, { header: { typ: 'JWT' } });

    expect(
      await harness.demo.verifier.verify(token, 'medissy:request'),
    ).toEqual({ ok: false, reason: 'wrong-type' });
  });

  it('rejects an unsigned token and garbage', async () => {
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString(
        'base64url',
      ),
      Buffer.from(
        JSON.stringify({ iss: ISSUER, sub: 's', aud: PUBLIC_URL }),
      ).toString('base64url'),
      '',
    ].join('.');

    expect(
      (await harness.demo.verifier.verify(unsigned, 'medissy:request')).ok,
    ).toBe(false);
    expect(
      await harness.demo.verifier.verify('not-a-jwt', 'medissy:request'),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      await harness.demo.verifier.verify('a'.repeat(9000), 'medissy:request'),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('takes organisation and roles from the institution sign-in (ID token roles, configured organisation), never from access token claims', async () => {
    const token = await signWithIdpKey(harness, {
      claims: {
        sub: 'synthetic-clinician-unregistered',
        roles: ['cardiologist'],
        organizationId: 'org-elsewhere',
      },
    });
    // an access token alone, even one carrying role and organisation claims
    const alone = await harness.demo.verifier.verify(token, 'medissy:request');

    expect(alone).toMatchObject({ ok: true, clinician: null });
    expect(alone.ok && alone.principal.roles).toEqual([]);
    expect(alone.ok && alone.principal.organizationId).toBeUndefined();

    // with the institution's ID token: its roles claim and the issuer's organisation
    const signedIn = await harness.demo.verifier.verifyClinician(
      {
        accessToken: token,
        idToken: await signIdToken(harness, {
          sub: 'synthetic-clinician-unregistered',
          roles: ['dentist'],
        }),
      },
      { scope: 'medissy:request', clientId: AGENT },
    );

    expect(signedIn).toMatchObject({
      ok: true,
      principal: { organizationId: ORG, roles: ['dentist'] },
      clinician: { organizationId: ORG, roles: ['dentist'] },
    });
  });

  it('rejects a token minted for a client without a person (client credentials)', async () => {
    const selfSubject = await signWithIdpKey(harness, {
      claims: { sub: 'medissy-agent' },
    });

    expect(
      await harness.demo.verifier.verify(selfSubject, 'medissy:request'),
    ).toEqual({ ok: false, reason: 'no-end-user' });
  });

  it('refuses the client-credentials grant at the issuer', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/demo-idp/token',
      headers: {
        'host': 'medissy.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'medissy-agent',
        scope: 'medissy:request',
        resource: PUBLIC_URL,
      }).toString(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(
      /unsupported_grant_type|unauthorized_client/,
    );
    expect(res.body).not.toContain('access_token');
  });

  it('rejects HS256 signed with the public key as the secret (alg confusion)', async () => {
    const { publicJwk } = await issuerKey(harness);
    const at = Math.floor(harness.clock.now().getTime() / 1000);
    const token = await new SignJWT({
      scope: 'medissy:request',
      client_id: 'medissy-agent',
      jti: 'x',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: publicJwk.kid })
      .setIssuer(ISSUER)
      .setAudience(PUBLIC_URL)
      .setSubject(DEMO_CARDIOLOGIST.subject)
      .setIssuedAt(at)
      .setExpirationTime(at + 300)
      .sign(new TextEncoder().encode(JSON.stringify(publicJwk)));

    expect(
      await harness.demo.verifier.verify(token, 'medissy:request'),
    ).toEqual({ ok: false, reason: 'bad-algorithm' });
  });
});

describe('fn:createAccessTokenVerifier verifyClinician (ADR-9)', () => {
  let harness: Harness;
  const expected = { scope: 'medissy:request', clientId: AGENT } as const;

  /**
   * reads the stored registry row of a subject at the institution
   * @param subject the clinician subject
   * @returns the row, or undefined
   */
  const registryRow = (
    subject: string = DEMO_CARDIOLOGIST.subject,
  ): Record<string, unknown> | undefined => {
    const row = harness.db
      .prepare(
        `SELECT display_name, organization_id, organization_name, roles, status
         FROM clinicians WHERE issuer = ? AND subject = ?`,
      )
      .get(ISSUER, subject);

    return row ? { ...row } : undefined;
  };

  /**
   * verifies a signed-in pair whose ID token carries the given claims
   * @param claims ID token payload changes
   * @returns the verification result
   */
  const signInWith = async (
    claims: Record<string, unknown>,
  ): ReturnType<Harness['demo']['verifier']['verifyClinician']> =>
    harness.demo.verifier.verifyClinician(
      {
        accessToken: await signWithIdpKey(harness),
        idToken: await signIdToken(harness, claims),
      },
      expected,
    );

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('takes roles from the allowlisted ID token claim and the organisation from the issuer config, on a real device sign-in', async () => {
    const tokens = await issuedTokens(harness, 'cardiologist');
    const result = await harness.demo.verifier.verifyClinician(
      tokens,
      expected,
    );

    expect(result).toMatchObject({
      ok: true,
      principal: {
        issuer: ISSUER,
        subject: DEMO_CARDIOLOGIST.subject,
        organizationId: ORG,
        roles: ['cardiologist'],
      },
      clinician: { status: 'active', roles: ['cardiologist'] },
    });
    expect(registryRow()).toEqual({
      display_name: DEMO_CARDIOLOGIST.displayName,
      organization_id: ORG,
      organization_name: 'Northgate Health (SYNTHETIC)',
      roles: '["cardiologist"]',
      status: 'active',
    });
  });

  it('ignores an organization or org claim in the ID token', async () => {
    const result = await signInWith({
      organization: 'org-attacker',
      org: 'org-attacker',
      organizationId: 'org-attacker',
      organization_name: 'Attacker Clinic',
    });

    expect(result).toMatchObject({
      ok: true,
      principal: { organizationId: ORG },
    });
    expect(registryRow()).toMatchObject({
      organization_id: ORG,
      organization_name: 'Northgate Health (SYNTHETIC)',
    });
  });

  it('never reads roles from a patient-kind issuer', async () => {
    const result = await harness.demo.verifier.verifyClinician(
      {
        accessToken: await signWithIdpKey(harness, { which: 'patient' }),
        idToken: await signIdToken(harness, {}, 'patient'),
      },
      expected,
    );

    expect(result).toEqual({ ok: false, reason: 'not-institution' });
    expect(
      harness.db.prepare('SELECT COUNT(*) AS n FROM clinicians').get(),
    ).toMatchObject({ n: 0 });
  });

  it('rejects an ID token for another subject than the access token', async () => {
    expect(await signInWith({ sub: 'synthetic-someone-else' })).toEqual({
      ok: false,
      reason: 'id-token-mismatch',
    });
    expect(registryRow()).toBeUndefined();
  });

  it('rejects an ID token from another issuer than the access token', async () => {
    const result = await harness.demo.verifier.verifyClinician(
      {
        accessToken: await signWithIdpKey(harness),
        idToken: await signIdToken(harness, {}, 'patient'),
      },
      expected,
    );

    expect(result).toEqual({ ok: false, reason: 'id-token-mismatch' });
  });

  it('rejects an ID token for another client, a missing one, and an access token in its place', async () => {
    const accessToken = await signWithIdpKey(harness);

    expect(await signInWith({ aud: 'medissy-portal' })).toEqual({
      ok: false,
      reason: 'wrong-audience',
    });
    expect(
      await harness.demo.verifier.verifyClinician({ accessToken }, expected),
    ).toEqual({ ok: false, reason: 'missing-id-token' });
    expect(
      await harness.demo.verifier.verifyClinician(
        {
          accessToken,
          idToken: await signWithIdpKey(harness, { claims: { aud: AGENT } }),
        },
        expected,
      ),
    ).toEqual({ ok: false, reason: 'wrong-type' });
    expect(
      await harness.demo.verifier.verifyClinician(
        {
          accessToken,
          idToken: await signWithIdpKey(harness, {
            claims: { aud: AGENT },
            header: { typ: 'application/at+jwt' },
          }),
        },
        expected,
      ),
    ).toEqual({ ok: false, reason: 'wrong-type' });
  });

  it('rejects an ID token whose nonce is not the sign-in nonce', async () => {
    const result = await harness.demo.verifier.verifyClinician(
      {
        accessToken: await signWithIdpKey(harness),
        idToken: await signIdToken(harness, { nonce: 'other' }),
      },
      { ...expected, nonce: 'expected' },
    );

    expect(result).toEqual({ ok: false, reason: 'invalid-claims' });
  });

  it('gives a role outside the allowlist the unknown-clinician result', async () => {
    const result = await signInWith({ roles: ['administrator', 'surgeon'] });

    expect(result).toMatchObject({ ok: true, clinician: null });
    expect(result.ok && result.principal.roles).toEqual([]);
    expect(result.ok && result.principal.organizationId).toBeUndefined();
    expect(registryRow()).toBeUndefined();
  });

  it('drops access at the next sign-in once the institution removes the role', async () => {
    expect(await signInWith({})).toMatchObject({
      ok: true,
      clinician: { roles: ['cardiologist'] },
    });

    const next = await signInWith({ roles: ['administrator'] });

    expect(next).toMatchObject({ ok: true, clinician: null });
    expect(registryRow()).toMatchObject({
      roles: '[]',
      organization_id: null,
      organization_name: null,
      status: 'active',
    });
  });

  it('fails closed on a role claim of the wrong type or absurd size, dropping earlier roles', async () => {
    await signInWith({});

    for (const roles of [
      'cardiologist',
      { cardiologist: true },
      [42],
      [''],
      ['x'.repeat(65)],
      Array.from({ length: 33 }, (_, index) => `role-${index}`),
    ]) {
      expect(await signInWith({ roles })).toEqual({
        ok: false,
        reason: 'invalid-roles',
      });
    }

    expect(registryRow()).toMatchObject({ roles: '[]', organization_id: null });
  });

  it('rejects a clinician sign-in from an untrusted issuer', async () => {
    const result = await harness.demo.verifier.verifyClinician(
      {
        accessToken: await signWithIdpKey(harness, {
          claims: { iss: 'https://evil.example/institution-idp' },
        }),
        idToken: await signIdToken(harness, {
          iss: 'https://evil.example/institution-idp',
        }),
      },
      expected,
    );

    expect(result).toEqual({ ok: false, reason: 'untrusted-issuer' });
  });

  it('rejects a clinician sign-in once the institution is disabled', async () => {
    harness.db
      .prepare('UPDATE trusted_issuers SET enabled = 0 WHERE issuer = ?')
      .run(ISSUER);

    expect(await signInWith({})).toEqual({
      ok: false,
      reason: 'untrusted-issuer',
    });
  });

  it('keeps the patient suspension across a just-in-time re-sign-in', async () => {
    await signInWith({});
    harness.db
      .prepare(
        "UPDATE clinicians SET status = 'suspended' WHERE issuer = ? AND subject = ?",
      )
      .run(ISSUER, DEMO_CARDIOLOGIST.subject);

    const again = await signInWith({ name: 'Dr Ada Renamed (SYNTHETIC)' });

    expect(again).toMatchObject({
      ok: true,
      clinician: {
        status: 'suspended',
        displayName: 'Dr Ada Renamed (SYNTHETIC)',
      },
    });
  });

  it('sanitises the display name from the ID token', async () => {
    await signInWith({ name: '  Dr\u0000 Ada‮\n\tNorthgate  ' });

    expect(registryRow()).toMatchObject({ display_name: 'Dr Ada Northgate' });

    await signInWith({ name: 42 });

    expect(registryRow()).toMatchObject({
      display_name: DEMO_CARDIOLOGIST.subject,
    });
  });
});
