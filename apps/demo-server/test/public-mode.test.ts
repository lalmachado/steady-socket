import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AUTH_FAILURE_CODE, rawToString, startDemoServer, type DemoServer } from '../src/server.js';

const ORIGIN = 'https://demo.example.com';
const A = 'session-aaaaaaaa';
const B = 'session-bbbbbbbb';

let server: DemoServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const base = () => `127.0.0.1:${String(server?.port)}`;
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://${base()}${path}`, { headers });
const post = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://${base()}${path}`, { method: 'POST', headers });

async function token(session: string): Promise<string> {
  const res = await get(`/token?session=${session}`);
  return ((await res.json()) as { token: string }).token;
}

/** Opens a client for a session and records what it receives and how it closes. */
async function connect(session: string, options: { headers?: Record<string, string> } = {}) {
  const ws = new WebSocket(`ws://${base()}/?token=${await token(session)}`, {
    headers: options.headers ?? {},
  });
  const received: { type: string; topic?: string }[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', resolve));
  ws.on('message', (raw) => {
    received.push(JSON.parse(rawToString(raw)) as { type: string; topic?: string });
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const send = (message: unknown) => {
    ws.send(JSON.stringify(message));
  };
  return { ws, received, closed, opened, send };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (condition: () => boolean, label: string, ms = 2000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${label}`);
    await sleep(10);
  }
};

describe('sessions: the controls only affect their own session', () => {
  it('silent: one session stops answering, the other keeps going', async () => {
    server = await startDemoServer({ port: 0, tickMs: 20 });
    const a = await connect(A);
    const b = await connect(B);
    await Promise.all([a.opened, b.opened]);

    await post(`/control/silent?session=${A}`);
    expect(server.state(A).silent).toBe(true);
    expect(server.state(B).silent).toBe(false);

    a.send({ type: 'ping' });
    b.send({ type: 'ping' });
    await until(() => b.received.some((m) => m.type === 'pong'), 'B to get a pong');
    await sleep(100);
    expect(a.received.some((m) => m.type === 'pong')).toBe(false);
    a.ws.close();
    b.ws.close();
  });

  it('restart: one session is dropped and refused, the other is not', async () => {
    server = await startDemoServer({ port: 0 });
    const a = await connect(A);
    const b = await connect(B);
    await Promise.all([a.opened, b.opened]);

    await post(`/control/restart?session=${A}&downMs=300`);
    expect(await a.closed).toBe(1012);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);

    const refused = await connect(A);
    await expect(refused.opened).rejects.toThrow();
    const fine = await connect(B);
    await fine.opened;

    await until(() => !server?.state(A).down, 'A to come back');
    b.ws.close();
    fine.ws.close();
  });

  it('expire-token: one session is closed with 4401, the other keeps a valid token', async () => {
    server = await startDemoServer({ port: 0 });
    const a = await connect(A);
    const spare = await token(B);
    const b = await connect(B);
    await Promise.all([a.opened, b.opened]);

    await post(`/control/expire-token?session=${A}`);
    expect(await a.closed).toBe(AUTH_FAILURE_CODE);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);

    const again = new WebSocket(`ws://${base()}/?token=${spare}`);
    await new Promise<void>((resolve, reject) => {
      again.once('open', resolve);
      again.once('error', reject);
    });
    again.close();
    b.ws.close();
  });

  it('reports one session, or all of them added together', async () => {
    server = await startDemoServer({ port: 0 });
    const a = await connect(A);
    const b = await connect(B);
    await Promise.all([a.opened, b.opened]);
    a.send({ type: 'subscribe', topic: 't' });
    b.send({ type: 'subscribe', topic: 't' });
    await until(() => server?.state().topics['t'] === 2, 'both subscriptions');

    expect(server.state(A)).toMatchObject({ connections: 1, topics: { t: 1 } });
    const over = (await (await get(`/state?session=${B}`)).json()) as { connections: number };
    expect(over.connections).toBe(1);
    const all = (await (await get('/state')).json()) as { connections: number };
    expect(all.connections).toBe(2);
    a.ws.close();
    b.ws.close();
  });

  it('refuses a malformed session id', async () => {
    server = await startDemoServer({ port: 0 });
    expect((await get('/token?session=x')).status).toBe(400);
    expect((await get('/token?session=has spaces and ../')).status).toBe(400);
  });
});

describe('public mode', () => {
  const start = (extra: Parameters<typeof startDemoServer>[0] = {}) =>
    startDemoServer({ port: 0, tickMs: 20, public: { allowedOrigins: [ORIGIN] }, ...extra });

  it('requires a session for tokens and controls, but not for /state', async () => {
    server = await start();
    expect((await get('/token')).status).toBe(400);
    expect((await post('/control/silent')).status).toBe(400);
    expect((await get('/state')).status).toBe(200);
  });

  it('answers an allowed origin and refuses another one, without running the control', async () => {
    server = await start();
    const ok = await get(`/token?session=${A}`, { origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);

    const bad = await post(`/control/silent?session=${A}`, { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    expect(server.state(A).silent).toBe(false); // refused, not just unreadable

    // Native apps and scripts send no Origin header: they are not refused.
    expect((await get(`/token?session=${A}`)).status).toBe(200);
  });

  it('refuses a WebSocket from another origin', async () => {
    server = await start();
    const bad = await connect(A, { headers: { origin: 'https://evil.example' } });
    await expect(bad.opened).rejects.toThrow();
    const good = await connect(A, { headers: { origin: ORIGIN } });
    await good.opened;
    good.ws.close();
  });

  it('caps the connections of one session (1013, not an auth failure)', async () => {
    server = await start({ public: { allowedOrigins: [ORIGIN], maxConnectionsPerSession: 2 } });
    const first = await connect(A);
    const second = await connect(A);
    const third = await connect(A);
    await Promise.all([first.opened, second.opened, third.opened]);
    expect(await third.closed).toBe(1013);
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
    // Another session is not affected.
    const other = await connect(B);
    await other.opened;
    for (const c of [first, second, other]) c.ws.close();
  });

  it('caps the connections in total', async () => {
    server = await start({ public: { allowedOrigins: [ORIGIN], maxConnections: 1 } });
    const first = await connect(A);
    await first.opened;
    const second = await connect(B);
    await expect(second.opened).rejects.toThrow();
    first.ws.close();
  });

  it('caps the sessions, and frees the room when a session is gone', async () => {
    server = await start({
      tokenTtlMs: 30,
      sweepMs: 20,
      public: { allowedOrigins: [ORIGIN], maxSessions: 1 },
    });
    expect((await get(`/token?session=${A}`)).status).toBe(200);
    expect((await get(`/token?session=${B}`)).status).toBe(503);
    await sleep(120); // A's token expired and the sweeper has removed the session
    expect((await get(`/token?session=${B}`)).status).toBe(200);
  });

  it('limits tokens and controls per session per minute', async () => {
    server = await start({
      public: { allowedOrigins: [ORIGIN], tokensPerMinute: 2, controlsPerMinute: 1 },
    });
    expect((await get(`/token?session=${A}`)).status).toBe(200);
    expect((await get(`/token?session=${A}`)).status).toBe(200);
    expect((await get(`/token?session=${A}`)).status).toBe(429);
    expect((await get(`/token?session=${B}`)).status).toBe(200); // someone else's budget

    expect((await post(`/control/silent?session=${A}`)).status).toBe(200);
    expect((await post(`/control/silent?on=false&session=${A}`)).status).toBe(429);
    expect(server.state(A).silent).toBe(true);
  });

  it('closes a connection that never authenticates', async () => {
    server = await start({ public: { allowedOrigins: [ORIGIN], authTimeoutMs: 60 } });
    const ws = new WebSocket(`ws://${base()}/`);
    const code = await new Promise<number>((resolve) => ws.on('close', resolve));
    expect(code).toBe(AUTH_FAILURE_CODE);
  });
});

describe('limits that always apply', () => {
  it('closes a connection that sends a huge message (1009)', async () => {
    server = await startDemoServer({ port: 0 });
    const c = await connect(A);
    await c.opened;
    c.ws.send('x'.repeat(10_000));
    expect(await c.closed).toBe(1009);
  });

  it('keeps at most 20 topics per connection and ignores very long topic names', async () => {
    server = await startDemoServer({ port: 0 });
    const c = await connect(A);
    await c.opened;
    for (let i = 0; i < 30; i++) c.send({ type: 'subscribe', topic: `topic-${String(i)}` });
    c.send({ type: 'subscribe', topic: 'x'.repeat(65) });
    await until(() => Object.keys(server?.state().topics ?? {}).length >= 20, '20 topics');
    await sleep(50);
    expect(Object.keys(server.state().topics)).toHaveLength(20);
    c.ws.close();
  });

  it('keeps the restart time between 0 and 30 s, and survives a bad value', async () => {
    server = await startDemoServer({ port: 0 });
    const res = await post(`/control/restart?session=${A}&downMs=banana`);
    expect(res.status).toBe(200);
    expect(server.state(A).down).toBe(true);
  });
});
