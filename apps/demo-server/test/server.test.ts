import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AUTH_FAILURE_CODE, rawToString, startDemoServer, type DemoServer } from '../src/server.js';

let server: DemoServer;
let base: string;

beforeEach(async () => {
  server = await startDemoServer({ port: 0, tickMs: 20 });
  base = `127.0.0.1:${String(server.port)}`;
});
afterEach(async () => {
  await server.close();
});

async function token(): Promise<string> {
  const res = await fetch(`http://${base}/token`);
  return ((await res.json()) as { token: string }).token;
}
const post = (path: string) => fetch(`http://${base}${path}`, { method: 'POST' });

/** Opens a client and records what it receives and how it closes. */
function connect(query = '') {
  const ws = new WebSocket(`ws://${base}/${query}`);
  const received: { type: string; topic?: string }[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
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

const until = async (condition: () => boolean, label: string, ms = 2000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('tokens and auth', () => {
  it('issues a different token each time', async () => {
    expect(await token()).not.toBe(await token());
  });

  it('delivers events after auth by message and subscribe', async () => {
    const c = connect();
    await c.opened;
    c.send({ type: 'auth', token: await token() });
    c.send({ type: 'subscribe', topic: 'bed:42' });
    await until(
      () => c.received.some((m) => m.type === 'event' && m.topic === 'bed:42'),
      'an event',
    );
    c.ws.close();
  });

  it('accepts a token in the URL instead of an auth message', async () => {
    const c = connect(`?token=${await token()}`);
    await c.opened;
    c.send({ type: 'subscribe', topic: 'a' });
    await until(() => c.received.some((m) => m.topic === 'a'), 'an event');
    c.ws.close();
  });

  it('closes with 4401 if you subscribe before authenticating', async () => {
    const c = connect();
    await c.opened;
    c.send({ type: 'subscribe', topic: 'a' });
    expect((await c.closed).code).toBe(AUTH_FAILURE_CODE);
  });

  it('closes with 4401 for a bad token, by message or in the URL', async () => {
    const byMessage = connect();
    await byMessage.opened;
    byMessage.send({ type: 'auth', token: 'nope' });
    expect((await byMessage.closed).code).toBe(AUTH_FAILURE_CODE);

    const byUrl = connect('?token=nope');
    expect((await byUrl.closed).code).toBe(AUTH_FAILURE_CODE);
  });

  it('closes a connection with 4401 when its token runs out', async () => {
    const short = await startDemoServer({ port: 0, tokenTtlMs: 150 });
    const res = await fetch(`http://127.0.0.1:${String(short.port)}/token`);
    const { token: t } = (await res.json()) as { token: string };
    const ws = new WebSocket(`ws://127.0.0.1:${String(short.port)}/?token=${t}`);
    const code = await new Promise<number>((resolve) => ws.on('close', resolve));
    expect(code).toBe(AUTH_FAILURE_CODE);
    await short.close();
  });
});

describe('subscriptions and heartbeat', () => {
  it('stops sending a topic after unsubscribe', async () => {
    const c = connect(`?token=${await token()}`);
    await c.opened;
    c.send({ type: 'subscribe', topic: 'a' });
    await until(() => c.received.length > 0, 'first event');
    c.send({ type: 'unsubscribe', topic: 'a' });
    await new Promise((r) => setTimeout(r, 60)); // let any in-flight event land
    const before = c.received.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(c.received.length).toBe(before);
    expect(server.state().topics).toEqual({});
    c.ws.close();
  });

  it('answers a ping with a pong', async () => {
    const c = connect();
    await c.opened;
    c.send({ type: 'ping' });
    await until(() => c.received.some((m) => m.type === 'pong'), 'a pong');
    c.ws.close();
  });
});

describe('control: silent', () => {
  it('keeps the connection open but answers nothing, until switched off', async () => {
    const c = connect(`?token=${await token()}`);
    await c.opened;
    c.send({ type: 'subscribe', topic: 'a' });
    await until(() => c.received.some((m) => m.type === 'event'), 'an event');

    await post('/control/silent');
    expect(server.state().silent).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    const before = c.received.length;
    c.send({ type: 'ping' });
    await new Promise((r) => setTimeout(r, 120));
    expect(c.received.length).toBe(before); // no pong, no events
    expect(c.ws.readyState).toBe(WebSocket.OPEN); // and no close either

    await post('/control/silent?on=false');
    c.send({ type: 'ping' });
    await until(() => c.received.some((m) => m.type === 'pong'), 'a pong again');
    c.ws.close();
  });
});

describe('control: restart', () => {
  it('drops everyone with 1012, refuses new connections for a while, then accepts again', async () => {
    const c = connect();
    await c.opened;
    await post('/control/restart?downMs=250');
    expect((await c.closed).code).toBe(1012);
    expect(server.state().down).toBe(true);

    const refused = connect();
    await expect(refused.opened).rejects.toThrow();

    await until(() => !server.state().down, 'the server to come back');
    const again = connect();
    await again.opened;
    again.ws.close();
  });
});

describe('control: expire-token', () => {
  it('closes everyone with 4401 and makes old tokens useless, but new tokens work', async () => {
    const old = await token();
    const c = connect(`?token=${old}`);
    await c.opened;
    await post('/control/expire-token');
    expect((await c.closed).code).toBe(AUTH_FAILURE_CODE);

    expect((await connect(`?token=${old}`).closed).code).toBe(AUTH_FAILURE_CODE);

    const fresh = connect(`?token=${await token()}`);
    await fresh.opened;
    fresh.send({ type: 'subscribe', topic: 'a' });
    await until(() => fresh.received.length > 0, 'an event with a fresh token');
    fresh.ws.close();
  });
});

describe('state and unknown routes', () => {
  it('reports connections and topics', async () => {
    const c = connect(`?token=${await token()}`);
    await c.opened;
    c.send({ type: 'subscribe', topic: 'bed:42' });
    await until(() => server.state().topics['bed:42'] === 1, 'the topic to register');
    const res = await fetch(`http://${base}/state`);
    expect(await res.json()).toMatchObject({ connections: 1, silent: false, down: false });
    c.ws.close();
  });

  it('answers 404 for anything else', async () => {
    expect((await fetch(`http://${base}/nope`)).status).toBe(404);
  });
});
