import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/server';
import { openVault } from '../src/vault/migrate';

import type { FastifyInstance } from 'fastify';

describe('fn:createApp', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('reports health without any patient data', async () => {
    app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', synthetic: true });
  });

  it('returns 404 for unknown routes', async () => {
    app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/unknown' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('runs the setups it is given on the root instance', async () => {
    app = await createApp({
      setup: [
        async (root) => root.get('/extra', async () => ({ extra: true })),
      ],
    });

    const response = await app.inject({ method: 'GET', url: '/extra' });

    expect(response.json()).toEqual({ extra: true });
  });

  it('serves over a real socket', async () => {
    app = await createApp();

    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${base}/healthz`);

    expect(response.status).toBe(200);
  });

  it('passes the one vault to every setup and closes it with the app', async () => {
    const db = openVault(':memory:');
    const seen: unknown[] = [];

    app = await createApp({
      db,
      setup: [
        async (_root, context) => seen.push(context.db),
        async (_root, context) => seen.push(context.db),
      ],
    });

    expect(seen).toEqual([db, db]);

    await app.close();
    app = undefined;
    expect(db.isOpen).toBe(false);
  });

  it('trusts exactly one proxy hop for the client address', async () => {
    app = await createApp({
      trustProxy: true,
      setup: [
        async (root) =>
          root.get('/ip', async (request) => ({ ip: request.ip })),
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
    });

    expect(response.json()).toEqual({ ip: '198.51.100.7' });
  });

  it('answers 421 for a host other than the public one, except health checks', async () => {
    app = await createApp({ allowedHosts: ['medissy.test'] });

    const foreign = await app.inject({
      method: 'GET',
      url: '/anything',
      headers: { host: 'evil.example' },
    });
    const health = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { host: 'evil.example' },
    });

    expect(foreign.statusCode).toBe(421);
    expect(health.statusCode).toBe(200);
  });
});
