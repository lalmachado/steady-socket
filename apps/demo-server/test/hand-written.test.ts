// The hand-written alternative (examples/hand-written.ts) against the demo server, with the same
// four scenarios as steady-socket.test.ts. It is the baseline the README compares the library
// with, so it has to be a fair one: if it did not pass these, the comparison would be a strawman.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createHandWrittenSocket, type Message } from '../../../examples/hand-written.js';
import { startDemoServer, type DemoServer } from '../src/server.js';

let server: DemoServer;
let socket: ReturnType<typeof createHandWrittenSocket> | undefined;

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

function handWritten() {
  const scores: number[] = [];
  let tokens = 0;
  const s = createHandWrittenSocket({
    url: `ws://127.0.0.1:${String(server.port)}`,
    getToken: async () => {
      const res = await fetch(`http://127.0.0.1:${String(server.port)}/token`);
      tokens++;
      return ((await res.json()) as { token: string }).token;
    },
    // `ws` is not the DOM `WebSocket` type, but it is the same API.
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    pingEveryMs: 100,
    pongTimeoutMs: 80,
    minDelayMs: 20,
    maxDelayMs: 100,
  });
  s.subscribe('match:42', (m: Message) => {
    if (m.type === 'event') scores.push((m.payload as { score: number }).score);
  });
  socket = s;
  return { s, scores, tokensUsed: () => tokens };
}

describe('the hand-written socket against the demo server', () => {
  it('connects, subscribes and receives events', async () => {
    const { s, scores } = handWritten();
    s.connect();
    await until(() => scores.length >= 2, 'two events');
    expect(s.state).toBe('open');
  });

  it('replaces a connection that stays open but goes silent, and subscribes again', async () => {
    const { s, scores, tokensUsed } = handWritten();
    s.connect();
    await until(() => scores.length >= 1, 'the first event');
    const tokensBefore = tokensUsed();

    await post('/control/silent');
    await until(() => tokensUsed() > tokensBefore, 'the heartbeat to give up and reconnect');
    await post('/control/silent?on=false');
    const seen = scores.length;
    await until(() => s.state === 'open' && scores.length > seen, 'events after recovery');
    expect(server.state().topics['match:42']).toBe(1); // subscribed again, once
  });

  it('survives a restart: keeps retrying while the server refuses, then recovers', async () => {
    const { s, scores } = handWritten();
    s.connect();
    await until(() => scores.length >= 1, 'the first event');

    await post('/control/restart?downMs=300');
    await until(() => s.state !== 'open', 'the drop');
    const seen = scores.length;
    await until(() => s.state === 'open' && scores.length > seen, 'recovery after the restart');
  });

  it('stops for good on an expired token instead of retrying forever', async () => {
    const { s } = handWritten();
    s.connect();
    await until(() => s.state === 'open', 'open');

    await post('/control/expire-token');
    await until(() => s.state === 'closed', 'closed');

    // No retry loop: the server sees no new connection after a pause.
    await new Promise((r) => setTimeout(r, 300));
    expect(server.state().connections).toBe(0);
  });
});
