// The point of the demo server: steady-socket survives everything it can do to it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createSocket, type ConnectionState, type Socket } from 'steady-socket';
import { AUTH_FAILURE_CODE, startDemoServer, type DemoServer } from '../src/server.js';

type Incoming = { type: 'pong' } | { type: 'event'; topic: string; payload: { score: number } };
type Outgoing =
  | { type: 'ping' }
  | { type: 'auth'; token: string }
  | { type: 'subscribe' | 'unsubscribe'; topic: string };

let server: DemoServer;
let socket: Socket<Incoming, Outgoing> | undefined;

beforeEach(async () => {
  server = await startDemoServer({ port: 0, tickMs: 20 });
});
afterEach(async () => {
  socket?.close();
  socket = undefined;
  await server.close();
});

const post = (path: string) =>
  fetch(`http://127.0.0.1:${String(server.port)}${path}`, { method: 'POST' });

const until = async (condition: () => boolean, label: string, ms = 4000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A socket set up the way the README shows, pointed at the demo server. */
function demoSocket() {
  const states: ConnectionState[] = [];
  const scores: number[] = [];
  let tokens = 0;
  const s = createSocket<Incoming, Outgoing>({
    // A fresh token on every connect, from the server's own /token endpoint.
    url: async () => {
      const res = await fetch(`http://127.0.0.1:${String(server.port)}/token`);
      tokens++;
      return `ws://127.0.0.1:${String(server.port)}/?token=${((await res.json()) as { token: string }).token}`;
    },
    // The README says to pass `ws` in Node. This line is also a check that it type-checks.
    WebSocket,
    heartbeat: {
      interval: 100,
      timeout: 80,
      ping: () => ({ type: 'ping' }),
      isPong: (m) => m.type === 'pong',
    },
    reconnect: { minDelay: 20, maxDelay: 100, factor: 2, jitter: 'full' },
    subscriptions: {
      subscribe: (topic) => ({ type: 'subscribe', topic }),
      unsubscribe: (topic) => ({ type: 'unsubscribe', topic }),
      topicOf: (m) => (m.type === 'event' ? m.topic : undefined),
    },
    isAuthFailure: (e) => e.code === AUTH_FAILURE_CODE,
  });
  s.onState((state) => states.push(state));
  s.subscribe('match:42', (m) => {
    if (m.type === 'event') scores.push(m.payload.score);
  });
  socket = s;
  return { s, states, scores, tokensUsed: () => tokens };
}

describe('steady-socket against the demo server', () => {
  it('connects, subscribes and receives events', async () => {
    const { s, scores } = demoSocket();
    s.connect();
    await until(() => scores.length >= 2, 'two events');
    expect(s.state).toBe('open');
  });

  it('replaces a connection that stays open but goes silent, and subscribes again', async () => {
    const { s, states, scores, tokensUsed } = demoSocket();
    s.connect();
    await until(() => scores.length >= 1, 'the first event');
    const tokensBefore = tokensUsed();

    await post('/control/silent');
    // The heartbeat notices no pong is coming and gives up on the connection.
    await until(() => states.includes('reconnecting'), 'the heartbeat to give up');
    // The new connection is silent too, so it is replaced again; bring the server back.
    await post('/control/silent?on=false');
    const seen = scores.length;
    await until(() => s.state === 'open' && scores.length > seen, 'events after recovery');
    expect(tokensUsed()).toBeGreaterThan(tokensBefore); // each connection got a fresh token
    expect(server.state().topics['match:42']).toBe(1); // subscribed again, once
  });

  it('survives a restart: keeps retrying while the server refuses, then recovers', async () => {
    const { s, states, scores } = demoSocket();
    s.connect();
    await until(() => scores.length >= 1, 'the first event');

    await post('/control/restart?downMs=300');
    await until(() => states.includes('reconnecting'), 'the drop');
    const seen = scores.length;
    await until(() => s.state === 'open' && scores.length > seen, 'recovery after the restart');
    expect(s.closeReason).toBeUndefined();
  });

  it('stops for good on an expired token instead of retrying forever', async () => {
    const { s } = demoSocket();
    s.connect();
    await until(() => s.state === 'open', 'open');

    await post('/control/expire-token');
    await until(() => s.state === 'closed', 'closed');
    expect(s.closeReason).toBe('auth-failure');

    // No retry loop: the server sees no new connection after a pause.
    await new Promise((r) => setTimeout(r, 300));
    expect(server.state().connections).toBe(0);
  });
});

describe('typing', () => {
  it('lets `ws` be passed as the WebSocket constructor', () => {
    // Compiles = the README advice ("pass `ws` in Node") works for TypeScript users.
    expect(WebSocket).toBeTypeOf('function');
  });
});
