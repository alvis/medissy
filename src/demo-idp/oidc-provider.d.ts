/**
 * minimal typings for the parts of oidc-provider 9.15.1 that Medissy uses;
 * the package ships no declarations; this covers only what src/demo-idp
 * touches, so a wrong call fails the typecheck instead of passing silently
 */
declare module 'oidc-provider' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export type AdapterPayload = Record<string, unknown> & {
    grantId?: string;
    userCode?: string;
    uid?: string;
    consumed?: number;
  };

  export interface Adapter {
    upsert(
      id: string,
      payload: AdapterPayload,
      expiresIn: number | undefined,
    ): Promise<void>;
    find(id: string): Promise<AdapterPayload | undefined>;
    findByUserCode(userCode: string): Promise<AdapterPayload | undefined>;
    findByUid(uid: string): Promise<AdapterPayload | undefined>;
    consume(id: string): Promise<void>;
    destroy(id: string): Promise<void>;
    revokeByGrantId(grantId: string): Promise<void>;
  }

  export interface ClientMetadata {
    client_id: string;
    client_name?: string;
    token_endpoint_auth_method?: string;
    grant_types?: string[];
    response_types?: string[];
    redirect_uris?: string[];
    id_token_signed_response_alg?: string;
    application_type?: 'web' | 'native';
  }

  export interface Client {
    clientId: string;
    clientName?: string;
  }

  export interface ResourceServerInfo {
    scope: string;
    audience: string;
    accessTokenTTL?: number;
    accessTokenFormat: 'jwt' | 'opaque';
    jwt?: { sign: { alg: string } };
  }

  export interface OIDCContext {
    readonly client?: Client;
    readonly route: string;
    readonly session?: {
      accountId?: string;
      grantIdFor(clientId: string): string | undefined;
    };
    readonly result?: {
      login?: { accountId: string };
      consent?: { grantId?: string };
    };
    readonly requestParamScopes: Set<string>;
    readonly requestParamOIDCScopes: Set<string>;
    readonly resourceServers?: Record<string, unknown>;
    readonly entities: {
      readonly DeviceCode?: { readonly params?: Record<string, unknown> };
    };
  }

  export interface KoaContextWithOIDC {
    oidc: OIDCContext;
    body: unknown;
    type: string;
    status: number;
    set(field: string, value: string): void;
  }

  export interface Account {
    accountId: string;
    claims(): Promise<Record<string, unknown>>;
  }

  export interface InteractionPrompt {
    name: string;
    reasons: string[];
    details: Record<string, unknown>;
  }

  export interface Interaction {
    uid: string;
    prompt: InteractionPrompt;
    params: Record<string, unknown>;
    exp: number;
  }

  export class Grant {
    constructor(properties: { clientId: string; accountId: string });
    readonly jti: string;
    addOIDCScope(scope: string): void;
    rejectOIDCScope(scope: string): void;
    addResourceScope(resource: string, scope: string): void;
    rejectResourceScope(resource: string, scope: string): void;
    save(): Promise<string>;
    static find(id: string): Promise<Grant | undefined>;
  }

  export class Check {
    static readonly REQUEST_PROMPT: true;
    static readonly NO_NEED_TO_PROMPT: false;
    constructor(
      reason: string,
      description: string,
      check: (ctx: KoaContextWithOIDC) => boolean,
    );
  }

  export interface Prompt {
    name: string;
    checks: Check[];
  }

  export interface InteractionPolicy extends Array<Prompt> {
    get(name: string): Prompt | undefined;
  }

  export const interactionPolicy: {
    base(): InteractionPolicy;
    Check: typeof Check;
  };

  export const errors: {
    InvalidTarget: new (description?: string) => Error;
    InvalidRequest: new (description?: string) => Error;
  };

  /** configuration keys Medissy sets; everything else keeps its default */
  export interface Configuration {
    adapter?: (model: string) => Adapter;
    clients?: ClientMetadata[];
    clientDefaults?: Partial<ClientMetadata>;
    jwks?: { keys: Array<Record<string, unknown>> };
    findAccount?: (
      ctx: KoaContextWithOIDC,
      sub: string,
    ) => Promise<Account | undefined>;
    claims?: Record<string, string[]>;
    /** extra authorization parameters with a validator each */
    extraParams?: Record<
      string,
      (
        ctx: KoaContextWithOIDC,
        value: unknown,
        client?: Client,
      ) => void | Promise<void>
    >;
    scopes?: string[];
    responseTypes?: string[];
    pkce?: { required: () => boolean };
    interactions?: {
      url: (ctx: KoaContextWithOIDC, interaction: Interaction) => string;
      policy?: InteractionPolicy;
    };
    loadExistingGrant?: (ctx: KoaContextWithOIDC) => Promise<Grant | undefined>;
    issueRefreshToken?: () => Promise<boolean>;
    renderError?: (
      ctx: KoaContextWithOIDC,
      out: Record<string, string>,
      error: Error,
    ) => Promise<void>;
    cookies?: {
      names?: { session?: string; interaction?: string; resume?: string };
      keys?: string[];
      long?: Record<string, unknown>;
      short?: Record<string, unknown>;
    };
    ttl?: Record<string, number>;
    features?: {
      devInteractions?: { enabled: boolean };
      clientCredentials?: { enabled: boolean };
      deviceFlow?: {
        enabled: boolean;
        userCodeInputSource?: (
          ctx: KoaContextWithOIDC,
          form: string,
          out?: unknown,
          error?: Error,
        ) => Promise<void>;
        userCodeConfirmSource?: (
          ctx: KoaContextWithOIDC,
          form: string,
          client: Client,
          deviceInfo: unknown,
          userCode: string,
        ) => Promise<void>;
        successSource?: (ctx: KoaContextWithOIDC) => Promise<void>;
      };
      resourceIndicators?: {
        enabled: boolean;
        defaultResource?: () => Promise<string>;
        useGrantedResource?: () => Promise<boolean>;
        getResourceServerInfo?: (
          ctx: KoaContextWithOIDC,
          resourceIndicator: string,
        ) => Promise<ResourceServerInfo>;
      };
      revocation?: { enabled: boolean };
      introspection?: { enabled: boolean };
      registration?: { enabled: boolean };
      rpInitiatedLogout?: { enabled: boolean };
    };
  }

  export default class Provider {
    constructor(issuer: string, configuration?: Configuration);
    readonly issuer: string;
    proxy: boolean;
    readonly Grant: typeof Grant;
    callback(): (req: IncomingMessage, res: ServerResponse) => void;
    interactionDetails(
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<Interaction>;
    interactionResult(
      req: IncomingMessage,
      res: ServerResponse,
      result: Record<string, unknown>,
      options?: { mergeWithLastSubmission?: boolean },
    ): Promise<string>;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}
