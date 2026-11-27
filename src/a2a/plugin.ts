/**
 * register Medissy's A2A surface on the root app: the Agent Card, the
 * JSON-RPC endpoint and the gated source download; registered through
 * `createApp({ setup })` with the shared vault
 */
import {
  UnsupportedOperationError,
  VersionNotSupportedError,
} from '@a2a-js/sdk/errors';
import {
  JsonRpcTransportHandler,
  defaultServerCallContextBuilder,
  validateVersion,
  UnauthenticatedUser,
} from '@a2a-js/sdk/server';

import { filesFullyWithin } from '../box/catalog';
import { clientKey } from '../identity/rate-limit';
import { createInboundPort } from '../inbound/service';
import { readPatientId } from '../policy/repository';
import { createInvitation, redeemInvitationHash } from '../sharing/invitations';
import { isOwner, readVaultOwner } from '../sharing/store';

import { A2A_PATH, AGENT_CARD_PATH, agentCard, agentCardJson } from './card';
import { createPipelinePort } from './disclosure-port';
import { DOWNLOAD_TEMPLATE, registerDownloads } from './downloads';
import { createTaskEngine } from './engine';
import { CLIENT_KEY_STATE, createRequestHandler } from './handler';
import { createTaskStore } from './task-store';

import type { DatabaseSync } from 'node:sqlite';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { SecureStore } from '../box/types';
import type { ConflictLink, SelectorClient } from '../disclosure';
import type { DeviceFlow } from '../identity/device-flow';
import type { Clock } from '../policy/engine';
import type { AppSetup } from '../server';

import type { DisclosurePort } from './disclosure-port';
import type { SourceFileReader } from './downloads';
import type { EngineDeps, EngineLogger, TaskEngine } from './engine';

/** the vault, clock and public origin the setup is built over */
interface Wiring {
  db: DatabaseSync;
  clock: Clock;
  base: string;
}

/** methods refused before the transport (no streaming in this build) */
const STREAMING_METHODS = new Set(['SendStreamingMessage', 'SubscribeToTask']);

/** options for `createA2aSetup` */
export interface A2aOptions {
  publicUrl: string;
  deviceFlow: Pick<DeviceFlow, 'start' | 'poll'>;
  /**
   * the patient owner's sign-in (`medissy:owner`); with it the share-code
   * skill issues invitations; without it the skill is unavailable
   */
  ownerDeviceFlow?: Pick<DeviceFlow, 'start' | 'poll'>;
  /** the relevance model; undefined without a configured key */
  selectorClient: SelectorClient | undefined;
  conflictLinks?: readonly ConflictLink[];
  /**
   * source file bytes for downloads; without it no download link is
   * advertised and the download route is not registered
   */
  reader?: SourceFileReader;
  clock?: Clock;
  /** replace the pipeline (tests) */
  disclosure?: DisclosurePort;
  taskTtlMs?: number;
  /** use this vault instead of the app's (tests that build the app elsewhere) */
  db?: DatabaseSync;
  /**
   * the patient's secure store for records clinicians hand back (ADR-10);
   * without it the `submit-record` skill is unavailable
   */
  secureStore?: SecureStore;
}

/**
 * returns the JSON-RPC request id, when the body has one
 * @param body the parsed body
 * @returns the id or null
 */
function rpcId(body: unknown): string | number | null {
  if (typeof body === 'object' && body !== null && 'id' in body) {
    const { id } = body;

    return typeof id === 'string' || typeof id === 'number' ? id : null;
  }

  return null;
}

/**
 * returns the JSON-RPC method, when the body has one
 * @param body the parsed body
 * @returns the method or undefined
 */
function rpcMethod(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'method' in body
    ? body.method
    : undefined;
}

/**
 * returns the invitation and share-code ports the engine uses, backed by the vault
 * @param app the app whose log receives the sharing events
 * @param wiring the vault, clock and public origin
 * @returns the two ports
 */
function sharingPorts(
  app: FastifyInstance,
  wiring: Wiring,
): Pick<EngineDeps, 'invitations' | 'shares'> {
  const { db, clock, base } = wiring;
  const sharing = {
    db,
    clock,
    publicOrigin: base,
    logger: { info: (entry: object) => app.log.info(entry) },
  };

  return {
    invitations: {
      redeem: ({ tokenHash, requester }) =>
        redeemInvitationHash(sharing, { tokenHash, requester, stated: {} }),
    },
    shares: {
      isOwner: (person) => isOwner(readVaultOwner(db), person),
      create: ({ owner }) => {
        const created = createInvitation(sharing, { owner });

        return created.ok ? created.share : undefined;
      },
    },
  };
}

/**
 * builds the task engine over the vault, the sign-in and the pipeline
 * @param app the app whose log receives the engine's events
 * @param options origin, sign-in, pipeline and download source
 * @param wiring the vault, clock and public origin
 * @returns a task engine whose releases go through the disclosure pipeline
 */
function buildEngine(
  app: FastifyInstance,
  options: A2aOptions,
  wiring: Wiring,
): TaskEngine {
  const { db, clock, base } = wiring;
  const { reader } = options;
  const logger: EngineLogger = {
    info: (entry) => app.log.info(entry),
    warn: (entry) => app.log.warn(entry),
  };
  const disclosure =
    options.disclosure ??
    createPipelinePort({
      db,
      clock,
      selectorClient: options.selectorClient,
      logger: {
        info: (entry) => app.log.info(entry),
        error: (entry) => app.log.error(entry),
      },
      conflictLinks: options.conflictLinks,
    });

  return createTaskEngine({
    store: createTaskStore(db),
    deviceFlow: options.deviceFlow,
    disclosure,
    sourceFiles: (patientId, recordIds) =>
      reader ? filesFullyWithin(db, patientId, recordIds) : [],
    readPatientId: () => readPatientId(db),
    clock,
    logger,
    links: {
      portalUrl: `${base}/`,
      downloadTemplate: reader ? `${base}${DOWNLOAD_TEMPLATE}` : undefined,
    },
    taskTtlMs: options.taskTtlMs,
    ownerDeviceFlow: options.ownerDeviceFlow,
    ...sharingPorts(app, wiring),
    ...(options.secureStore
      ? {
          inbound: createInboundPort({
            db,
            store: options.secureStore,
            clock,
            logger: {
              info: (entry) => app.log.info(entry),
              warn: (entry) => app.log.warn(entry),
            },
          }),
        }
      : {}),
  });
}

/**
 * answers a JSON-RPC error with no caching
 * @param reply the reply to send on
 * @param id the request id, or null
 * @param error the error to map to JSON-RPC
 * @returns the reply
 */
function failure(
  reply: FastifyReply,
  id: string | number | null,
  error: Error,
): FastifyReply {
  return reply.header('Cache-Control', 'no-store').send({
    jsonrpc: '2.0',
    id,
    error: JsonRpcTransportHandler.mapToJSONRPCError(error),
  });
}

/**
 * serves one JSON-RPC request: version check, no streaming, then the transport
 * @param rpc the Agent Card and the JSON-RPC transport
 * @param rpc.card the Agent Card the version is checked against
 * @param rpc.transport the JSON-RPC transport
 * @param request the incoming request
 * @param reply the reply to answer on
 * @returns the reply
 */
async function handleRpc(
  rpc: {
    card: ReturnType<typeof agentCard>;
    transport: JsonRpcTransportHandler;
  },
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const { card, transport } = rpc;
  const { body } = request;
  const id = rpcId(body);
  const header = request.headers['a2a-version'];
  const version = Array.isArray(header) ? header[0] : header;
  const fail = (error: Error): FastifyReply => failure(reply, id, error);

  try {
    if (!version) {
      throw new VersionNotSupportedError(
        'The A2A-Version header is required (1.0).',
      );
    }

    validateVersion(version, card, 'JSONRPC');
  } catch {
    return fail(
      new VersionNotSupportedError('Unsupported A2A version; use 1.0.'),
    );
  }

  if (STREAMING_METHODS.has(String(rpcMethod(body)))) {
    return fail(new UnsupportedOperationError('Streaming is not supported.'));
  }

  const context = defaultServerCallContextBuilder({
    extensions: undefined,
    user: new UnauthenticatedUser(),
    headers: request.headers,
    requestedVersion: version,
  });

  // the per-client sign-in cap keys on the client IP (one trusted hop),
  // with IPv6 clients grouped by /64
  context.state.set(CLIENT_KEY_STATE, clientKey(request.ip));

  const result = await transport.handle(
    (body ?? '') as string | Record<string, unknown>,
    context,
  );

  if (Symbol.asyncIterator in result) {
    return fail(new UnsupportedOperationError('Streaming is not supported.'));
  }

  return reply.header('Cache-Control', 'no-store').send(result);
}

/**
 * builds the A2A setup
 * @param options origin, issuer, sign-in, pipeline and download source
 * @returns the setup to pass to `createApp`
 */
export function createA2aSetup(options: A2aOptions): AppSetup {
  return async (app: FastifyInstance, context) => {
    const db = options.db ?? context.db;

    if (!db) {
      throw new Error('the A2A surface needs the vault');
    }

    const clock = options.clock ?? (() => new Date());
    const { reader } = options;
    const base = options.publicUrl.replace(/\/$/, '');
    const cardOptions = {
      publicUrl: base,
      shareCodeAvailable: Boolean(options.ownerDeviceFlow),
      recordSubmissionAvailable: Boolean(options.secureStore),
    };
    const card = agentCard(cardOptions);
    const cardJson = agentCardJson(cardOptions);
    const engine = buildEngine(app, options, { db, clock, base });
    const transport = new JsonRpcTransportHandler(
      createRequestHandler({ engine, card }),
    );

    app.get(AGENT_CARD_PATH, async (_request, reply) =>
      reply.header('Cache-Control', 'public, max-age=300').send(cardJson),
    );

    // the body carries task ids, but request logs never include bodies
    app.post(A2A_PATH, async (request, reply) =>
      handleRpc({ card, transport }, request, reply),
    );

    if (reader) {
      registerDownloads(app, { db, engine, reader });
    }
  };
}
