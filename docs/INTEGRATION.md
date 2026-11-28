# Integration notes

## Versions and SDK fit (SPK06)

Evidence labels: **[observed]** means I ran it or read the shipped source or registry data on 2026-11-25. **[inferred]** means reasoned from docs or types and not executed. **NOT RUN** means no live check was possible.

Scratch spike (not project code): all candidate versions below installed together with `npm install` in a throwaway directory, then exercised on Node 24.22.3. `package.json` of the project was not touched.

### Pinned versions

| Package | Exact version | Purpose | Evidence URL |
| --- | --- | --- | --- |
| Node.js | 24.22.3 (LTS "Krypton"); `engines.node` stays `>=24` | Runtime; `node:sqlite` unflagged [observed: `DatabaseSync` ran, SQLite 3.54.1, no flag, no warning] | https://nodejs.org/api/sqlite.html |
| fastify | 5.12.8 | HTTP server for A2A, IdP mount, portal [observed] | https://registry.npmjs.org/fastify/5.12.8 |
| @fastify/formbody | 9.0.2 | `application/x-www-form-urlencoded` for portal forms [observed registers and parses] | https://registry.npmjs.org/@fastify/formbody/9.0.2 |
| @fastify/cookie | 11.1.5 | Signed cookies for portal session [observed registers] | https://registry.npmjs.org/@fastify/cookie/11.1.5 |
| @fastify/csrf-protection | 8.0.2 | CSRF tokens for portal forms; decorates `app.csrfProtection` and `reply.generateCsrf` [observed] | https://registry.npmjs.org/@fastify/csrf-protection/8.0.2 |
| zod | 4.6.7 | Validation; works with the Anthropic `zodOutputFormat` helper [observed] | https://registry.npmjs.org/zod/4.6.7 |
| jose | 6.2.18 | JWT verification; verified an `at+jwt` token against the IdP JWKS [observed]. SDKs depend on `jose ^6.2.x` so one copy dedupes [observed in manifests] | https://registry.npmjs.org/jose/6.2.18 |
| oidc-provider | 9.15.1 | Demo IdP (Koa-based; depends on `koa ^3.3.0`) [observed] | https://registry.npmjs.org/oidc-provider/9.15.1 |
| @a2a-js/sdk | 1.3.0 | A2A 1.0 server core and types; do not use its Express binding [observed] | https://registry.npmjs.org/@a2a-js/sdk/1.3.0 |
| uqr | 0.1.3 | QR matrix (`encode`) for the PNG part and `renderSVG` for the share card [observed, 4.3 KB SVG]; the PNG is built with `node:zlib` | https://registry.npmjs.org/uqr/0.1.3 |
| @anthropic-ai/sdk | 1.14.0 | Sonnet 5.5 selector; `zod` is an optional peer `^3.25 \|\| ^4` [observed] | https://registry.npmjs.org/@anthropic-ai/sdk/1.14.0 |

All eleven were `dist-tags.latest` on 2026-11-25 [observed]. Not needed: `@fastify/express` and `@fastify/middie` (the IdP mounts through `callback()` without them [observed]); `express` (optional peer of the A2A SDK, and absent from `node_modules` after install [observed]).

## A2A verdict

**Partial use of the SDK plus a thin Fastify adapter.** Use the SDK's framework-neutral server core. Do not use `@a2a-js/sdk/server/express`. Do not hand-write a spec-compliant protocol layer.

### Evidence

- **Method names and wire format are 1.0** [observed]. `JsonRpcTransportHandler` (dist source comment: `src/server/transports/jsonrpc/jsonrpc_transport_handler.ts`) dispatches `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, the four push-config methods and `GetExtendedAgentCard`. These match spec §5.3 and §9.4. Legacy `message/send` and `tasks/get` sent with `A2A-Version: 1.0` returned `-32601` in the spike.
- **States** [observed]. `TaskState` includes `TASK_STATE_AUTH_REQUIRED` and `TASK_STATE_INPUT_REQUIRED` (spec §4.1.3). The spike returned `TASK_STATE_AUTH_REQUIRED` from `SendMessage`, the same state from `GetTask`, then `TASK_STATE_COMPLETED` after a follow-up `SendMessage` with the same `taskId`/`contextId` (spec §3.4.3, §7.6).
- **Parts and artifacts** [observed]. Parts serialize without a `kind` discriminator (spec Appendix A.2.1): `{"text":...}`, `{"data":{...},"mediaType":"application/json"}`, `{"raw":"<base64>","filename":"v.html","mediaType":"text/html"}`. `SendMessage` result is wrapped as `{"result":{"task":{...}}}` (spec §9.4.1).
- **Agent Card** [observed]. The SDK `AgentCard` type has `supportedInterfaces[{url,protocolBinding,protocolVersion,tenant}]`, `securitySchemes`, `securityRequirements`, `capabilities.extendedAgentCard`, `skills`, `defaultInput/OutputModes`, `signatures` (spec §4.4.1, §4.4.6). `AgentCard.toJSON` output in the spike is ProtoJSON (camelCase, oneof by member name, empty fields omitted). OAuth flows `authorizationCode` and `deviceCode` exist in the SDK types (spec §4.5.7-4.5.10); the spike advertised `authorizationCode` only; the shipped card with `deviceCode` round-trips the SDK schema [tested] `spec/a2a/e2e.spec.ts` "serves a generic Agent Card that round-trips the SDK schema and names no patient data". The SDK constant `AGENT_CARD_PATH` is `.well-known/agent-card.json` (spec §14.3).
- **Fastify** [observed]. `@a2a-js/sdk/server` exports `DefaultRequestHandler`, `JsonRpcTransportHandler`, `InMemoryTaskStore`, `AgentEvent`, `defaultServerCallContextBuilder` and `validateVersion` without importing Express. The Express file (`src/server/express/json_rpc_handler.ts`) is a short wrapper: build context, `validateVersion`, `handle(body, context)`, write JSON or SSE. A 20-line Fastify route doing the same served all calls above. The SDK's own v0.3 compat README states its transport handlers are meant to be mounted "from any HTTP runtime (Express, Fastify, Hono, ...)" [observed text].
- **Spec page** [observed]. https://a2a-protocol.org/v1.0.1/specification/ is labelled "Latest Released Version 1.0.0" and shows no 1.0.1 changelog; patch versions are excluded from negotiation (§3.6). Spec inconsistencies noted: §8.5 sample card uses `security` while the §4.4.1 table and the SDK use `securityRequirements`; §9.3 shows `category/action` while §9.1 requires PascalCase. Follow the tables and the SDK.

### Adapter gotchas found in the spike [observed]

1. The executor must call `eventBus.finished()` after publishing. Without it the blocking `SendMessage` hung until abort.
2. Every `execute()` must publish a `task` or `message` event first, including on follow-up turns (SDK type comment).
3. The SDK already appends the incoming user message to task history. Re-adding it in the executor duplicated it.
4. A request with no `A2A-Version` header is treated as `0.3` and rejected with `-32009 VersionNotSupported`. This is spec-correct (§3.6.2). A generic client that omits the header will fail unless the card also declares a `0.3` interface and the legacy handler is mounted (`LegacyJsonRpcTransportHandler` from `@a2a-js/sdk/compat/v0_3/server`, [inferred], not run).
5. `InMemoryTaskStore` loses tasks on restart. The SDK's database store lists `better-sqlite3`, `pg`, `mysql2`, `kysely` as optional peers, not `node:sqlite`, so a small `TaskStore` over `node:sqlite` is needed [inferred from the exports and peer list].
6. Streaming (`SendStreamingMessage`, SSE) was not exercised: **NOT RUN**. Keep `capabilities.streaming: false` for the MVP.

### Departure in the build (AGT) [tested]

Medissy keeps the SDK's `JsonRpcTransportHandler`, `validateVersion` and error types. It replaces the SDK's `DefaultRequestHandler` with its own handler (`src/a2a/handler.ts`), for three reasons:

- `DefaultRequestHandler` mints task IDs with `randomUUID`.
- It serves GetTask straight from the store, without re-checking the grant.
- It lists every task ID through ListTasks. Under D10 a task ID is the only secret, so that would leak every task's capability.

Two behaviours follow, each covered by `spec/a2a/e2e.spec.ts`:

- A `messageId` that any client already used returns `-32602`. The reply never contains the existing task or its receipt.
- An extended card request returns `-32007` (not configured).

## Record hand-back (ADR-10)

- **A2A.** The card lists `submit-record`. Its description says "Not available in this deployment" unless `MEDISSY_INBOUND_STORE` is `box` or `fixture`. The input is one data part: `{"skill":"submit-record","record":<FHIR R4 Observation | DiagnosticReport | DocumentReference | Condition | MedicationStatement | AllergyIntolerance>}` or `{"skill":"submit-record","document":{"title","text","authoredAt?"}}`, with an optional `category` (`cardiac`, `dental`, `musculoskeletal`, `dermatology`). It must be at most 64 KiB and have no `contained` resources and no attachment URLs. The task goes `AUTH_REQUIRED` → device approval → `COMPLETED` with a text part and an `application/vnd.medissy.submission+json` data part `{status:"filed", submissionId, recordId, resourceType, category, filedName, filedAt}`. Without an active grant the task ends with the same denial a clinical request gets. A refused record ends `REJECTED`, and a store failure ends `FAILED`. [tested] `spec/a2a/e2e.spec.ts` "A2A record hand-back (ADR-10)".
- **Box upload.** `createConnectorStore` (`src/box/connector.ts`) sends `POST {BOX_GATEWAY_BASE}/{BOX_GATEWAY_CONNECTION_ID}/upload/files/content` with no `/2.0` prefix. The body is multipart: an `attributes` part `{"name":"inbound-<yyyymmdd>-<8 hex>.json","parent":{"id":"<BOX_ALLOWED_FOLDER_ID>"}}` first, then the `file` part. It sends no credential and refuses any redirect. The reply must hold exactly one entry, in the allowed folder, with the same name and size and a valid version id. [tested] `spec/box/store.spec.ts` against a stub. Against the real gateway it is **NOT RUN**: the live policy blocks `/upload/*` ([scripts/deploy.md](../scripts/deploy.md)).
- **Client skill.** `skills/a2a-client/SKILL.md` tells the agent to send only what the clinician wrote or chose, and only when the card lists `submit-record` as available. `a2a.mjs` is unchanged.

## oidc-provider 9.15.1 findings

- **Device flow** [observed]: `features.deviceFlow.enabled` defaults to `false` and must be set. With it on, discovery lists `device_authorization_endpoint` and the grant `urn:ietf:params:oauth:grant-type:device_code`; `POST /demo-idp/device/auth` returned `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in: 600` for a request carrying `resource=`.
- **Resource indicators (RFC 8707)** [observed]: `features.resourceIndicators.enabled` defaults to `true`. `getResourceServerInfo` must return `scope`, `audience`, and for JWT `accessTokenFormat: 'jwt'` and `jwt: { sign: { alg } }`.
- **JWT access tokens (RFC 9068)** [observed]: the issued token header was `{alg: ES256, typ: at+jwt, kid}`; payload had `iss`, `aud` (the resource), `sub`, `scope`, `client_id`, `jti`, `iat`, `exp`; `jose.jwtVerify(token, remoteJWKS, {issuer, audience, typ: 'at+jwt'})` passed. Source throws if a JWT access token has no audience (`lib/models/formats/jwt.js`), so a `resource` (or `defaultResource`) is mandatory. The spike obtained the token via `client_credentials` for speed; the device and authorization-code paths use the same token formatter [inferred].
- **PKCE** [observed]: `code_challenge_methods_supported: ["S256"]`; `pkce.required` set true in the spike.
- **Sub-path mount via `callback()`** [observed]: works in Fastify with `reply.hijack()`, `req.raw.originalUrl = original`, `req.raw.url = url.slice('/demo-idp'.length)`, then `provider.callback()(req.raw, reply.raw)`, with issuer `http://host/demo-idp`. The provider derives its mount path from `req.originalUrl` minus `request.url` (`lib/helpers/oidc_context.js`). Register both `/demo-idp` and `/demo-idp/*`.
- **Form bodies** [observed]: with `@fastify/formbody` registered globally the stream is already drained; setting `req.raw.body = req.body` makes the provider fall back to it, but it logs a warning each start. Preferable [inferred]: register the IdP in its own encapsulated plugin with a pass-through content-type parser so the stream stays unread.
- **Two issuers from one factory** [observed, ADR-9]: `/demo-idp` (patient owner) and `/institution-idp` (Northgate Health, SYNTHETIC) are two `Provider` instances with separate signing keys (`idp_store` rows `es256` and `es256-institution`) and cookie names (`cookies.names`, `_northgate_*` for the institution). Both share the `idp_store` adapter; rate-limit buckets are shared by name across the two mounts.
- **Roles in the ID token** [tested, ADR-9]: `claims: { openid: ['sub', 'name', 'roles'] }` plus `findAccount(...).claims()` returning `roles` puts `name` and `roles` into the ID token for both the device grant and the authorization code grant, even when the access token has a resource audience; discovery lists `roles` in `claims_supported`. Medissy reads the claim named by `trusted_issuers.role_claim` and intersects it with `allowed_roles` ([tested] `spec/identity/verifier.spec.ts` "takes roles from the allowlisted ID token claim and the organisation from the issuer config, on a real device sign-in").
- **Config traps** [observed]: with an ES256-only JWKS every client needs `id_token_signed_response_alg: 'ES256'` or `invalid_client_metadata` is returned. The in-memory adapter prints a "will lose state on restart" warning, and TTL functions print notices; set both explicitly.
- **Not run**: interactive login/consent and device user-code approval (needs our own `/interaction` UI because `devInteractions` was disabled), full authorization-code + PKCE round trip, refresh. The portal must implement the interaction routes [inferred].

## Anthropic: Sonnet 5.5 structured output

Based on the claude-api skill (TypeScript docs and `shared/model-migration.md` -> Migrating to Claude Sonnet 5.5). Type-check [observed]: compiles under `tsc --strict` against `@anthropic-ai/sdk@1.14.0`, `zod@4.6.7`. Wire request [observed]: with a stubbed `fetch` the SDK sent `model`, `max_tokens`, `system`, `messages`, and `output_config: {effort: "low", format: {type: "json_schema", schema: {... additionalProperties: false, required: [...]}}}`, and `parsed_output` came back typed. **Live call: NOT RUN (no key).**

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const Selection = z.object({
  selected_ids: z.array(z.string()),
  reason: z.string(),
});
type Selection = z.infer<typeof Selection>;

export async function selectWithSonnet(
  client: Anthropic, // new Anthropic() reads ANTHROPIC_API_KEY
  system: string,
  user: string,
): Promise<Selection | null> {
  const res = await client.messages.parse(
    {
      model: "claude-sonnet-5-5",
      max_tokens: 4096, // thinking tokens count toward this cap
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: zodOutputFormat(Selection) },
    },
    { timeout: 20_000, maxRetries: 0 }, // TypeScript timeout is milliseconds
  );
  if (res.stop_reason === "refusal" || res.parsed_output === null) return null;
  return res.parsed_output; // null => deterministic fallback (D5)
}
```

Constraints from the skill [inferred, not live-verified]:

- `thinking: {type: "disabled"}` returns 400 on `claude-sonnet-5-5`; adaptive thinking is the default. Use `effort: "low"`, or `thinking: {type: "between_tools"}` at effort `high` or below, with no other thinking field.
- Forced `tool_choice` (`any`/`tool`) returns 400; structured outputs replace it. Non-default `temperature`, `top_p`, `top_k` return 400. Omit them.
- Structured outputs are incompatible with citations (400).
- The SDK retries timeouts; default `maxRetries` is 2, so wall-clock can reach `timeout x 3`. `maxRetries: 0` keeps the selector's bound at 20 s before the deterministic fallback.
- Refusals arrive as HTTP 200 with `stop_reason: "refusal"`; the snippet routes them to the fallback. The skill recommends the server-side `fallbacks` option (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"` on `client.beta.messages`) by default for this model. It is not used here because D5 already supplies a deterministic fallback and I could not verify the beta path without a key. This is a decision for the main agent.
- Price per the skill's cached table (2026-11-03): $2 / $10 per MTok in/out.

## OpenClaw client skill

OpenClaw reaches Medissy over A2A 1.0 only, through the generic skill `skills/a2a-client/` (D7). The skill has two files: `SKILL.md` and `a2a.mjs`, a plain Node 24 ESM script with no dependencies. There is no plugin, no MCP server and no token in the client. Clinician identity is bound inside the task by the AUTH_REQUIRED device sign-in, and Medissy keeps the token (D8). The script contains nothing specific to Medissy. Its only input is an agent origin, which must be https (or http on localhost) and must be listed in `A2A_ALLOWED_ORIGINS`.

### Commands and envelope

`node a2a.mjs card|send|get|wait <origin> ...` prints exactly one JSON line on stdout:

`{state, text, terminal?, taskId?, contextId?, timedOut?, signin?, html?, images?, data?, agent?, error?}`

- `signin` keeps only `verificationUri`, `userCode` and `expiresAt`. The link must be https (or http on localhost), with no credentials, query or fragment. A sign-in with any other link is dropped whole.
- `html` is a completed task's artifact `text/html` part, decoded and otherwise unchanged, for `show_widget` (D9; departure I-2). HTML from a status message or from an unfinished, rejected or failed task is dropped.
- `images` lists `{path, mediaType}` for a completed task's artifact `image/png` or `image/jpeg` parts, at most 4, each at most 512 KiB and starting with its format's signature. SVG and anything else is dropped. Each image is written to a fresh `0700` temporary directory as a `0600` file; only the path reaches the envelope. SKILL.md has the agent end its reply with one `MEDIA:<path>` line per image, which OpenClaw shows as an attachment (the share QR).
- `text` has these characters stripped: C0/C1 controls, U+061C, U+200B–U+200F, U+2028–U+202E, U+2066–U+2069 and U+FEFF. `data` gets the same cleaning, recursively, at most 32 levels deep. Any `device_code`, `verification_uri_complete` or `*token*` key is dropped wherever it appears.
- `taskId` and `contextId` must match `^[A-Za-z0-9._:-]{1,128}$`, both in responses and in argv. Anything else is refused (`unsafe-id` or `usage`), so a hostile agent cannot plant shell metacharacters in the command the model runs next.
- `send` takes `--data-b64` (base64url JSON, needs no quoting), which SKILL.md makes the primary path. `--data` and `--text` remain, under the rule that `'` is written as `'\''`.
- `wait` polls GetTask every 5 s, or at the interval a task part asks for (clamped to 1–60 s). It keeps polling through `submitted`, `working` and `auth-required`, and stops at any other state or at `--timeout`, which defaults to 120 s and allows at most 900 s. On timeout it returns `timedOut: true`.
- Exit codes:
  - 0: the agent answered, in any task state (`rejected` and `failed` included).
  - 1: the client refused or the call failed (`state: "error"`).
  - 2: usage error.

### Security behaviour [tested: `spec/skills/a2a-client.spec.ts`]

- The client refuses, without fetching:
  - an origin outside `A2A_ALLOWED_ORIGINS` (also when the variable is unset);
  - an http origin that is not localhost;
  - an origin carrying credentials, a path or a query.
- It refuses an Agent Card whose JSON-RPC endpoint is on another origin, and never posts to that endpoint. It also refuses a card with no 1.x JSON-RPC interface.
- It sends `redirect: 'manual'` and treats any 3xx as a refusal. The redirect target is never requested.
- Responses are capped at 2 MiB, whether declared in `content-length` or streamed. Each request times out after 15 s (`A2A_REQUEST_TIMEOUT_MS` overrides). Non-JSON and non-2xx responses are refused.
- Every call sends `A2A-Version: 1.0` and PascalCase `SendMessage`/`GetTask`. Each `send` uses a fresh `randomUUID` messageId, so repeated requests never hit the `-32602` collision.
- Nothing is written to stderr or logs. The only files written are the checked artifact images above. Task IDs (D10) and user codes appear only in the stdout envelope, which stays in the OpenClaw session.

### Profiles

The three profiles are `profiles/patient`, `profiles/cardiology` and `profiles/dental`. Each has:

- a `workspace/` directory (AGENTS.md, IDENTITY.md, SOUL.md, USER.md);
- an `openclaw.json5` template with a distinct gateway port (19781, 19782, 19783);
- `logging.level: "silent"`;
- the skill loaded through `skills.load.extraDirs`;
- `A2A_ALLOWED_ORIGINS` set through `skills.entries["a2a-client"].env`.

They contain no secrets, and each file carries a SYNTHETIC DEMO note. Each profile's state lives in `~/.openclaw-medissy-<profile>` (`openclaw --profile`).

### Install (OpenClaw 2026.11.9 desktop)

From the repository root, with `MEDISSY_ORIGIN` set to the deployed origin (for example `https://<sprite>.sprites.app`):

```bash
for p in patient cardiology dental; do
  mkdir -p ~/.openclaw-medissy-$p
  sed -e "s#__REPO__#$PWD#g" -e "s#__MEDISSY_ORIGIN__#$MEDISSY_ORIGIN#g" \
    profiles/$p/openclaw.json5 > ~/.openclaw-medissy-$p/openclaw.json
  openclaw --profile medissy-$p config validate
  openclaw --profile medissy-$p skills info a2a-client   # expect "a2a-client ✓ Ready"
done
```

Then, for each profile:

1. Give the profile model credentials with `openclaw --profile medissy-<p> configure`. This is the user's step; no keys go in the repository.
2. Start its gateway with `openclaw --profile medissy-<p> gateway`.
3. Attach it in the OpenClaw desktop app.

In the cardiology profile, ask, for example, "Ask Medissy for current cardiac medications and allergies for encounter `<id>`". When the agent shows a verification link and code, sign in as the demo cardiologist at `/institution-idp` (Northgate Health, SYNTHETIC) in your own browser. The agent then waits and shows the evidence card.

### Evidence

- **[observed]** With the bundled CLI (`~/.openclaw/bin/openclaw`, 2026.11.9), on all three rendered profiles in isolated `/tmp` state dirs:
  - `openclaw config validate` reports "Config valid".
  - `openclaw skills info a2a-client` reports "✓ Ready", source `openclaw-extra`, with requirements `node` and `A2A_ALLOWED_ORIGINS` met.
- **[tested]** 41 vitest cases in `spec/skills/a2a-client.spec.ts` run the script against an in-process Medissy (real HTTP on an ephemeral port, real `/institution-idp` device approval for doctors and `/demo-idp` for the owner, real disclosure pipeline with a fake selector) and against stub servers. The in-process Medissy and its demo IdP are configured as `https://medissy.test`. The journey covered is card → send → AUTH_REQUIRED → approval → wait → COMPLETED, with the HTML byte-identical to Medissy's part and a DisclosureResult carrying a FHIR Bundle. A real `/bin/sh` passes an apostrophe question intact both as `--data-b64` and as quoted `--data`. The security review probe (`/tmp/medissy-cli-probe/probe.mts`) reports no shell side effect, no surviving control characters, no leaked device code and no status-message HTML.
- **NOT RUN**:
  - a model-driven OpenClaw turn calling the skill;
  - `show_widget` rendering Medissy's card in the desktop app (A-1, SPK04 still NEEDS-USER-CHECK);
  - the QR share and redeem flows through OpenClaw;
  - the profiles' gateways running side by side;
  - whether `logging.level: "silent"` fully suppresses the file log, and where session transcripts are kept (the per-agent SQLite store holds them; there is no documented off switch).
- **A12: NOT RUN** until the user observes, in the OpenClaw desktop app, the cardiology profile complete the in-task sign-in and show the evidence widget. The portal fallback is the text part's portal link.

## Open risks

1. Header-less A2A clients fail with `-32009` (decided: 1.0 only; header-less clients are refused).
2. SDK released 1.0.0 to 1.3.0 in about ten weeks; pin exactly and re-run the spike on each bump.
3. Streaming and the legacy 0.3 handler are NOT RUN. Device approval and the auth-code round trip are tested locally (`spec/a2a/e2e.spec.ts`, `spec/portal/step-up.spec.ts`) but NOT RUN behind the Sprite URL (SPK05).
4. `@types/node` is pinned to `24.19.4` to match the Node 24 runtime.
5. Live Anthropic call NOT RUN; effort `low` and `max_tokens` 4096 are untuned.
6. Spec page at `/v1.0.1/` presents as 1.0.0; no observable 1.0.1 delta.
7. The Box connector upload (`/upload/files/content`) is tested only against a stub. The real gateway's multipart handling and response shape are NOT RUN (ADR-10).
