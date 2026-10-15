import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from './helpers/fake-websocket';
import { setup, type Msg } from './helpers/setup';

const heartbeat = {
  interval: 10_000,
  timeout: 3000,
  ping: (): Msg => ({ type: 'ping' }),
  isPong: (m: Msg) => m.type === 'pong',
};

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

async function openSocket(overrides = {}) {
  const ctx = setup({ heartbeat, ...overrides });
  ctx.socket.connect();
  await vi.advanceTimersByTimeAsync(0);
  FakeWebSocket.last.open();
  return ctx;
}

describe('heartbeat', () => {
  it('sends no ping before the socket is open', async () => {
    const { socket } = setup({ heartbeat });
    socket.connect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.last.sent).toEqual([]);
  });

  it('pings every interval while open', async () => {
    await openSocket();
    await vi.advanceTimersByTimeAsync(9999);
    expect(FakeWebSocket.last.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.last.sent).toEqual([PING]);
    FakeWebSocket.last.receive(PONG);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWebSocket.last.sent).toEqual([PING, PING]);
  });

  it('stays open while pongs keep arriving in time', async () => {
    const { socket } = await openSocket();
    await vi.advanceTimersByTimeAsync(10_000); // first ping goes out
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(2999); // the pong is almost too late
      FakeWebSocket.last.receive(PONG);
      await vi.advanceTimersByTimeAsync(7001); // next ping goes out
    }
    expect(socket.state).toBe('open');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('treats a socket that is open but silent as dead: closes it and reconnects', async () => {
    const { socket, states } = await openSocket();
    const dead = FakeWebSocket.last;
    dead.goSilent();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.state).toBe('open');
    await vi.advanceTimersByTimeAsync(2999);
    expect(socket.state).toBe('open');
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.state).toBe('reconnecting');
    expect(dead.closeCalls).toEqual([{ code: 4000, reason: 'heartbeat timeout' }]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last.open();
    expect(states).toEqual(['connecting', 'open', 'reconnecting', 'connecting', 'open']);
  });

  it('ignores a late close event from the socket it gave up on', async () => {
    const { socket } = await openSocket();
    const dead = FakeWebSocket.last;
    await vi.advanceTimersByTimeAsync(13_000);
    expect(socket.state).toBe('reconnecting');
    dead.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('starts a fresh heartbeat on the new connection', async () => {
    await openSocket();
    await vi.advanceTimersByTimeAsync(13_000);
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeWebSocket.last;
    next.open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(next.sent).toEqual([PING]);
  });

  it('does not stack a second ping while one is waiting for its pong', async () => {
    await openSocket({ heartbeat: { ...heartbeat, interval: 1000, timeout: 5000 } });
    await vi.advanceTimersByTimeAsync(4999);
    expect(FakeWebSocket.last.sent).toEqual([PING]);
  });

  it('consumes pongs: they are not passed to onMessage listeners', async () => {
    const { socket } = await openSocket();
    const received: Msg[] = [];
    socket.onMessage((m) => received.push(m));
    await vi.advanceTimersByTimeAsync(10_000);
    FakeWebSocket.last.receive(PONG);
    FakeWebSocket.last.receive('{"type":"event"}');
    expect(received).toEqual([{ type: 'event' }]);
  });

  it('stops all timers when the server closes the connection', async () => {
    const { socket } = await openSocket();
    await vi.advanceTimersByTimeAsync(10_000);
    FakeWebSocket.last.serverClose();
    socket.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops all timers on close()', async () => {
    const { socket } = await openSocket();
    await vi.advanceTimersByTimeAsync(10_000);
    socket.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('is off by default', async () => {
    const { socket } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.last.sent).toEqual([]);
    expect(socket.state).toBe('open');
  });
});
