/**
 * the synthetic OIDC issuers, built by one factory so both carry the same
 * safeguards: the patient's issuer at `/demo-idp` and the Northgate Health
 * institution at `/institution-idp` (ADR-9); each is oidc-provider 9.15.1
 * configured per the SPK06 findings (docs/INTEGRATION.md): device flow on,
 * RFC 9068 `at+jwt` access tokens bound to Medissy's audience, ES256 only,
 * the vault-backed adapter, no dev interactions, and its own signing key and
 * cookies; the institution also puts the person's `name` and roles in the ID
 * token; production replaces both with external IdPs through
 * `IssuerConnection` (ADR-3)
 */
import { createLocalJWKSet } from 'jose';
import OidcProvider, { errors, interactionPolicy } from 'oidc-provider';

import {
  SIGNIN_CONTEXT_PARAMS,
  signInContextSchema,
} from '../contracts/signin';

import { accountConfiguration } from './accounts';
import { createSqliteAdapter } from './adapter';
import { loadOrCreateSigningKey } from './keys';
import {
  deviceConfirmPage,
  deviceInputPage,
  deviceSuccessPage,
  errorPage,
  PAGE_CSP,
} from './pages';
import { issuerUrl, PATIENT_ISSUER } from './users';

import type { DatabaseSync } from 'node:sqlite';

import type { JWK, JWTVerifyGetKey } from 'jose';
import type {
  Client,
  ClientMetadata,
  Configuration,
  KoaContextWithOIDC,
} from 'oidc-provider';

import type { SignInContext } from '../contracts/signin';

import type { IssuerConnection } from '../identity/issuer';

import type { IssuerProfile } from './users';

/** path the patient's issuer is mounted on inside the Fastify app */
export const DEMO_IDP_MOUNT = PATIENT_ISSUER.mount;

/** public PKCE client used by the portal's browser sign-in */
export const PORTAL_CLIENT_ID = 'medissy-portal';

/** public client used by the in-task device flow */
export const AGENT_CLIENT_ID = 'medissy-agent';

const SIGNING_ALG = 'ES256';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** lifetimes in seconds; everything is short because this is a demo */
const TTL = {
  AccessToken: 600,
  AuthorizationCode: 60,
  DeviceCode: 600,
  IdToken: 600,
  Interaction: 600,
  Session: 900,
  Grant: 900,
} as const;

/** display names of the registered clients, for the sign-in pages */
export const CLIENT_NAMES: Readonly<Record<string, string>> = {
  [PORTAL_CLIENT_ID]: 'Medissy portal',
  [AGENT_CLIENT_ID]: 'Medissy (agent sign-in)',
};

/** options for `createDemoProvider` */
export interface DemoProviderOptions {
  /** which synthetic issuer to build; the patient's by default */
  profile?: IssuerProfile;
  /** a vault opened through `openVault`; holds the adapter store and key */
  db: DatabaseSync;
  /** public origin of Medissy, e.g. `https://medissy.example` */
  publicUrl: string;
  /** resource indicator tokens are bound to; defaults to `publicUrl` */
  audience?: string;
  /** keys signing the IdP's own cookies; random per process when omitted */
  cookieKeys?: string[];
  /** encrypts the stored signing key (`DEMO_IDP_KEY_ENCRYPTION_KEY`) */
  keyEncryptionKey?: Buffer;
}

/** the configured issuer and what Medissy needs to talk to it */
export interface DemoProvider {
  profile: IssuerProfile;
  provider: OidcProvider;
  issuer: string;
  audience: string;
  connection: IssuerConnection;
  /** public signing keys, as served at `<mount>/jwks` */
  publicJwks: { keys: JWK[] };
  /** in-process key set for the verifier (no HTTP round trip to itself) */
  keySet: JWTVerifyGetKey;
}

/**
 * removes a trailing slash so URLs join predictably
 * @param url an origin or URL
 * @returns the URL without a trailing slash
 */
function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * sets the synthetic page headers on a provider-rendered response
 * @param ctx the provider's Koa context
 * @param body the HTML page
 */
function sendPage(ctx: KoaContextWithOIDC, body: string): void {
  ctx.type = 'html';
  ctx.set('content-security-policy', PAGE_CSP);
  ctx.set('cache-control', 'no-store');
  ctx.body = body;
}

/**
 * builds the interaction policy: the stock login and consent prompts plus one
 * check that always asks which synthetic account to use, so an existing IdP
 * session never approves a device code without the person choosing an account
 * @returns the interaction policy for the demo provider
 */
function demoPolicy(): ReturnType<typeof interactionPolicy.base> {
  const policy = interactionPolicy.base();

  policy
    .get('login')
    ?.checks.push(
      new interactionPolicy.Check(
        'demo_account_choice',
        'the demo always asks which synthetic account to use',
        (ctx) => ctx.oidc.result === undefined,
      ),
    );

  return policy;
}

/**
 * builds the two public clients: the portal (authorization code with PKCE) and
 * the agent (device code); neither may use client credentials, so every token
 * names a signed-in person
 * @param origin Medissy's public origin
 * @returns the client metadata
 */
function demoClients(origin: string): ClientMetadata[] {
  return [
    {
      client_id: PORTAL_CLIENT_ID,
      client_name: CLIENT_NAMES[PORTAL_CLIENT_ID],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      redirect_uris: [`${origin}/auth/callback`],
      id_token_signed_response_alg: SIGNING_ALG,
    },
    {
      client_id: AGENT_CLIENT_ID,
      client_name: CLIENT_NAMES[AGENT_CLIENT_ID],
      token_endpoint_auth_method: 'none',
      grant_types: [DEVICE_CODE_GRANT],
      response_types: [],
      id_token_signed_response_alg: SIGNING_ALG,
    },
  ];
}

/**
 * builds the validators for the task-context parameters: each is required and
 * valid for the agent client and refused for any other client
 * @returns the `extraParams` configuration
 */
function signInContextParams(): NonNullable<Configuration['extraParams']> {
  const shape = signInContextSchema.shape;

  return Object.fromEntries(
    Object.entries(SIGNIN_CONTEXT_PARAMS).map(([field, param]) => [
      param,
      (_ctx: KoaContextWithOIDC, value: unknown, client?: Client) => {
        if (client?.clientId !== AGENT_CLIENT_ID) {
          if (value !== undefined) {
            throw new errors.InvalidRequest(`${param} is not allowed`);
          }

          return;
        }

        if (!shape[field as keyof SignInContext].safeParse(value).success) {
          throw new errors.InvalidRequest(`${param} is missing or invalid`);
        }
      },
    ]),
  );
}

/**
 * reads the task context stored with the device code being confirmed
 * @param ctx the provider's Koa context
 * @returns the validated context, or null
 */
function confirmedContext(ctx: KoaContextWithOIDC): SignInContext | null {
  const params = ctx.oidc.entities.DeviceCode?.params ?? {};
  const parsed = signInContextSchema.safeParse(
    Object.fromEntries(
      Object.entries(SIGNIN_CONTEXT_PARAMS).map(([field, param]) => [
        field,
        params[param],
      ]),
    ),
  );

  return parsed.success ? parsed.data : null;
}

/**
 * builds the device flow with Medissy's own pages; the confirm page shows the
 * task
 * @param label the issuer's SYNTHETIC banner
 * @returns the `deviceFlow` feature configuration
 */
function deviceFlowFeature(
  label: string,
): NonNullable<NonNullable<Configuration['features']>['deviceFlow']> {
  return {
    enabled: true,
    userCodeInputSource: async (...[ctx, form, , error]) => {
      const message = error
        ? 'That code did not work. Check it and try again.'
        : 'Type the code your agent showed you.';

      sendPage(ctx, deviceInputPage({ label, providerForm: form, message }));
    },
    userCodeConfirmSource: async (...[ctx, form, client, , userCode]) => {
      sendPage(
        ctx,
        deviceConfirmPage({
          label,
          providerForm: form,
          clientName: CLIENT_NAMES[client.clientId] ?? client.clientId,
          userCode,
          context: confirmedContext(ctx),
        }),
      );
    },
    successSource: async (ctx) => {
      sendPage(ctx, deviceSuccessPage(label));
    },
  };
}

/**
 * binds every access token to Medissy's audience as an ES256 `at+jwt`
 * @param audience the only resource indicator accepted
 * @param resourceScopes the scopes this issuer can grant for Medissy
 * @returns the `resourceIndicators` feature configuration
 */
function resourceIndicatorsFeature(
  audience: string,
  resourceScopes: readonly string[],
): NonNullable<NonNullable<Configuration['features']>['resourceIndicators']> {
  return {
    enabled: true,
    defaultResource: async () => audience,
    useGrantedResource: async () => true,
    getResourceServerInfo: async (_ctx, resourceIndicator) => {
      if (resourceIndicator !== audience) {
        throw new errors.InvalidTarget();
      }

      return {
        scope: resourceScopes.join(' '),
        audience,
        accessTokenTTL: TTL.AccessToken,
        accessTokenFormat: 'jwt',
        jwt: { sign: { alg: SIGNING_ALG } },
      };
    },
  };
}

/**
 * builds the provider configuration
 * @param input vault, origin, audience, cookie keys and private key
 * @param input.options the provider options
 * @param input.profile the issuer being built
 * @param input.origin Medissy's public origin
 * @param input.audience the resource indicator
 * @param input.privateJwk the signing key
 * @returns the configuration passed to the OIDC provider
 */
function configuration(input: {
  options: DemoProviderOptions;
  profile: IssuerProfile;
  origin: string;
  audience: string;
  privateJwk: JWK;
}): Configuration {
  const { profile } = input;

  return {
    adapter: createSqliteAdapter(input.options.db),
    jwks: { keys: [input.privateJwk] },
    clients: demoClients(input.origin),
    ...accountConfiguration(profile),
    extraParams: signInContextParams(),
    scopes: ['openid'],
    responseTypes: ['code'],
    pkce: { required: () => true },
    interactions: {
      url: (_ctx, interaction) =>
        `${profile.mount}/interaction/${interaction.uid}`,
      policy: demoPolicy(),
    },
    issueRefreshToken: async () => false,
    renderError: async (ctx, out) => {
      sendPage(
        ctx,
        errorPage({
          label: profile.label,
          title: 'Sign-in error',
          detail: out.error_description ?? out.error ?? '',
        }),
      );
    },
    cookies: {
      names: { ...profile.cookieNames },
      keys: input.options.cookieKeys,
      long: { httpOnly: true, sameSite: 'lax' },
      short: { httpOnly: true, sameSite: 'lax' },
    },
    ttl: { ...TTL },
    features: {
      devInteractions: { enabled: false },
      clientCredentials: { enabled: false },
      deviceFlow: deviceFlowFeature(profile.label),
      resourceIndicators: resourceIndicatorsFeature(
        input.audience,
        profile.resourceScopes,
      ),
      revocation: { enabled: false },
      introspection: { enabled: false },
      registration: { enabled: false },
      rpInitiatedLogout: { enabled: false },
    },
  };
}

/**
 * builds one synthetic issuer; its signing key is loaded from, or created in,
 * the vault under the issuer's own row
 *
 * `proxy` is always on: the Fastify plugin replaces every `X-Forwarded-*`
 * header with values derived from the configured public URL and Fastify's
 * own (one-hop) client address before the provider sees the request, so the
 * provider builds URLs and Secure cookies for the public origin only
 * @param options vault, public URL, audience, cookie keys and key encryption
 * @returns the provider and its connection details
 */
export async function createDemoProvider(
  options: DemoProviderOptions,
): Promise<DemoProvider> {
  const profile = options.profile ?? PATIENT_ISSUER;
  const origin = trimSlash(options.publicUrl);
  const issuer = issuerUrl(origin, profile);
  const audience = options.audience ?? origin;
  const { privateJwk, publicJwk } = await loadOrCreateSigningKey(options.db, {
    kek: options.keyEncryptionKey,
    keyId: profile.signingKeyId,
  });
  const provider = new OidcProvider(
    issuer,
    configuration({ options, profile, origin, audience, privateJwk }),
  );

  provider.proxy = true;

  const publicJwks = { keys: [publicJwk] };

  return {
    profile,
    provider,
    issuer,
    audience,
    connection: {
      issuer,
      authorizationEndpoint: `${issuer}/auth`,
      tokenEndpoint: `${issuer}/token`,
      deviceAuthorizationEndpoint: `${issuer}/device/auth`,
      portalClientId: PORTAL_CLIENT_ID,
      agentClientId: AGENT_CLIENT_ID,
    },
    publicJwks,
    keySet: createLocalJWKSet(publicJwks),
  };
}
