/**
 * wire both synthetic issuers to the identity layer: trust them, verify their
 * tokens with their in-process key sets, and build the sign-in, session,
 * device-flow and rate-limit pieces; the flow picks the issuer, never the
 * caller: owner flows use the patient's issuer, clinician flows the Northgate
 * Health institution (ADR-9); with external IdPs (ADR-3) only this file
 * changes
 */
import { SCOPE_OWNER, SCOPE_REQUEST } from '../contracts';
import { createDeviceFlow } from '../identity/device-flow';
import { createVaultDirectory } from '../identity/directory';
import { createInternalCaller } from '../identity/internal-fetch';
import { createIdentity } from '../identity/plugin';
import { rateLimitPlugin } from '../identity/rate-limit';
import { createAccessTokenVerifier } from '../identity/verifier';
import { webSecurityPlugin } from '../identity/web-security';

import { createLockout } from './lockout';
import { demoIdpPlugin } from './plugin';
import { AGENT_CLIENT_ID, createDemoProvider } from './provider';
import { loadPassphrases } from './secrets';
import { ensureDemoTrust } from './seed';
import { INSTITUTION_ISSUER, PATIENT_ISSUER } from './users';

import type { DatabaseSync } from 'node:sqlite';

import type { DeviceFlow } from '../identity/device-flow';
import type { InternalCaller } from '../identity/internal-fetch';
import type { Fetch } from '../identity/issuer';
import type { Identity } from '../identity/plugin';
import type { RateRule } from '../identity/rate-limit';
import type { AccessTokenVerifier } from '../identity/verifier';
import type { AppSetup } from '../server';

import type { DemoProvider } from './provider';
import type { PassphraseBook } from './secrets';

/** options for `createDemoIdentity` */
export interface DemoIdentityOptions {
  db: DatabaseSync;
  publicUrl: string;
  /** per-persona passphrases (plaintext or `scrypt$` hashes) by persona key */
  passphrases: Readonly<Record<string, string | undefined>>;
  cookieKeys?: string[];
  /** encrypts the stored signing key */
  keyEncryptionKey?: Buffer;
  secureCookies?: boolean;
  /** overrides the per-IP rate limits (tests) */
  rateRules?: readonly RateRule[];
  /**
   * HTTP client for issuer calls; defaults to an in-process client for
   * Medissy's own origin, exempt from the per-IP limits
   */
  fetch?: Fetch;
  now?: () => Date;
}

/** everything the app and the A2A engine need from identity */
export interface DemoIdentity {
  /** the patient's issuer at `/demo-idp`: owner sign-ins */
  idp: DemoProvider;
  /** the Northgate Health institution at `/institution-idp`: doctor sign-ins */
  institution: DemoProvider;
  identity: Identity;
  verifier: AccessTokenVerifier;
  /** a clinician's in-task sign-in at the institution (`medissy:request`) */
  deviceFlow: DeviceFlow;
  /** the patient owner's in-task sign-in (`medissy:owner`), for share codes */
  ownerDeviceFlow: DeviceFlow;
  /** run these, in order, on the root app (see `createApp`'s `setup`) */
  setup: AppSetup[];
}

/** what the root setups need */
interface SetupParts {
  options: DemoIdentityOptions;
  internal: InternalCaller;
  identity: Identity;
  issuers: readonly DemoProvider[];
  passphrases: PassphraseBook;
  secureCookies: boolean;
}

/**
 * builds the root setups, in order: rate limits (exempting Medissy's own
 * in-process issuer calls), web security, portal identity, then each synthetic
 * issuer with its own lockout
 * @param parts the composed pieces
 * @returns the setups to register on the root app
 */
function rootSetups(parts: SetupParts): AppSetup[] {
  const { options, internal, secureCookies } = parts;

  return [
    (app) => {
      internal.bind(app);

      return app.register(rateLimitPlugin, {
        rules: options.rateRules,
        isExempt: (request) => internal.isInternal(request),
        now: options.now,
      });
    },
    (app) => app.register(webSecurityPlugin, { secureCookies }),
    (app) => app.register(parts.identity.plugin),
    ...parts.issuers.map(
      (idp): AppSetup =>
        (app) =>
          app.register(demoIdpPlugin, {
            idp,
            passphrases: parts.passphrases,
            lockout: createLockout({ now: options.now }),
            secureCookies,
          }),
    ),
  ];
}

/**
 * builds the device flows: the clinician's at the institution, verified as a
 * doctor sign-in (access and ID token), and the owner's at the patient's
 * issuer, verified as the owner's access token
 * @param parts the composed pieces the flows need
 * @param parts.options the demo identity options
 * @param parts.idp the patient's issuer
 * @param parts.institution the institution issuer
 * @param parts.verifier the token verifier
 * @param parts.fetch the HTTP client for issuer calls
 * @returns the clinician device flow and the owner-scoped one
 */
function createDeviceFlows(parts: {
  options: DemoIdentityOptions;
  idp: DemoProvider;
  institution: DemoProvider;
  verifier: AccessTokenVerifier;
  fetch: typeof fetch;
}): Pick<DemoIdentity, 'deviceFlow' | 'ownerDeviceFlow'> {
  const { options, idp, institution, verifier, fetch } = parts;
  const shared = { db: options.db, fetch, now: options.now };

  return {
    deviceFlow: createDeviceFlow({
      ...shared,
      connection: institution.connection,
      audience: institution.audience,
      scope: SCOPE_REQUEST,
      verifySignIn: async (tokens) =>
        verifier.verifyClinician(tokens, {
          scope: SCOPE_REQUEST,
          clientId: AGENT_CLIENT_ID,
        }),
    }),
    ownerDeviceFlow: createDeviceFlow({
      ...shared,
      connection: idp.connection,
      audience: idp.audience,
      scope: SCOPE_OWNER,
      verifySignIn: async (tokens) =>
        verifier.verify(tokens.accessToken, SCOPE_OWNER),
    }),
  };
}

/**
 * builds both synthetic issuers, each with its own signing key and cookies,
 * and registers them as trusted
 * @param options vault, public URL, cookie keys, key encryption and clock
 * @returns the patient's issuer and the institution
 */
async function createIssuers(
  options: DemoIdentityOptions,
): Promise<Pick<DemoIdentity, 'idp' | 'institution'>> {
  const providerOptions = {
    db: options.db,
    publicUrl: options.publicUrl,
    cookieKeys: options.cookieKeys,
    keyEncryptionKey: options.keyEncryptionKey,
  };
  const idp = await createDemoProvider({
    ...providerOptions,
    profile: PATIENT_ISSUER,
  });
  const institution = await createDemoProvider({
    ...providerOptions,
    profile: INSTITUTION_ISSUER,
  });

  ensureDemoTrust(options.db, {
    publicUrl: options.publicUrl,
    audience: idp.audience,
    now: options.now,
  });

  return { idp, institution };
}

/**
 * builds both synthetic issuers and the identity layer that trusts them
 * @param options vault, public URL, secrets, cookie settings, HTTP and clock
 * @returns the composed pieces
 */
export async function createDemoIdentity(
  options: DemoIdentityOptions,
): Promise<DemoIdentity> {
  const secureCookies = options.secureCookies ?? true;
  const passphrases = await loadPassphrases(options.passphrases);
  const internal = createInternalCaller(options.publicUrl);
  const fetch = options.fetch ?? internal.fetch;
  const { idp, institution } = await createIssuers(options);
  const directory = createVaultDirectory(options.db);
  const keySets = new Map(
    [idp, institution].map((issuer) => [issuer.issuer, issuer.keySet]),
  );
  const verifier = createAccessTokenVerifier({
    directory,
    keys: (trusted) => keySets.get(trusted.issuer),
    now: options.now,
  });
  const identity = createIdentity({
    directory,
    verifier,
    connections: {
      owner: idp.connection,
      clinician: institution.connection,
    },
    publicUrl: options.publicUrl,
    audience: idp.audience,
    fetch,
    now: options.now,
    secureCookies,
  });
  const { deviceFlow, ownerDeviceFlow } = createDeviceFlows({
    options,
    idp,
    institution,
    verifier,
    fetch,
  });

  return {
    idp,
    institution,
    identity,
    verifier,
    deviceFlow,
    ownerDeviceFlow,
    setup: rootSetups({
      options,
      internal,
      identity,
      issuers: [idp, institution],
      passphrases,
      secureCookies,
    }),
  };
}
