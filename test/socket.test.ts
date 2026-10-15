import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createSocket } from '../src';
import type { ConnectionState, SocketOptions, WebSocketConstructor } from '../src';
import { FakeWebSocket } from './helpers/fake-websocket';

type Msg = { type: string };

function setup(overrides: Partial<SocketOptions<Msg, Msg>> = {}) {
  const socket = createSocket<Msg, Msg>({
    url: 'wss://example.test/ws',
    WebSocket: FakeWebSocket,
    reconnect: { minDelay: 1000, maxDelay: 8000, factor: 2, jitter: 'none' },
    ...overrides,
  });
  const states: ConnectionState[] = [];
  socket.onState((s) => states.push(s));
  return { socket, states };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('state machine', () => {
  it('starts idle and does nothing until connect()', () => {
    const { socket } = setup();
    expect(socket.state).toBe('idle');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('idle → connecting → open', async () => {
    const { socket, states } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('connecting');
    FakeWebSocket.last.open();
    expect(socket.state).toBe('open');
    expect(states).toEqual(['connecting', 'open']);
  });

  it('open → reconnecting → connecting → open after the server drops the connection', async () => {
    const { socket, states } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(1006);
    expect(socket.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.state).toBe('connecting');
    FakeWebSocket.last.open();
    expect(states).toEqual(['connecting', 'open', 'reconnecting', 'connecting', 'open']);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('connecting → reconnecting when the connection fails before opening', async () => {
    const { socket } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose(1006);
    expect(socket.state).toBe('reconnecting');
  });

  it('connect() is a no-op unless idle', async () => {
    const { socket } = setup();
    socket.connect();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not notify when the state does not change', () => {
    const { socket, states } = setup();
    socket.close();
    socket.close();
    expect(states).toEqual(['closed']);
  });

  it('stops notifying a listener after it unsubscribes', () => {
    const { socket } = setup();
    const listener = vi.fn();
    const off = socket.onState(listener);
    off();
    socket.connect();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('url', () => {
  it('accepts a string', async () => {
    const { socket } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.last.url).toBe('wss://example.test/ws');
  });

  it('calls an async provider on every connect attempt', async () => {
    let n = 0;
    const { socket } = setup({
      url: () => Promise.resolve(`wss://example.test/ws?token=${String(++n)}`),
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.last.url).toMatch(/token=1$/);
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.last.url).toMatch(/token=2$/);
  });

  it('treats a throwing provider as a failed attempt and retries', async () => {
    let calls = 0;
    const { socket } = setup({
      url: () => {
        if (++calls === 1) throw new Error('token fetch failed');
        return 'wss://example.test/ws';
      },
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('passes protocols through', async () => {
    const { socket } = setup({ protocols: ['v1'] });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.last.protocols).toEqual(['v1']);
  });
});

describe('backoff', () => {
  it('waits longer after each consecutive failure and resets after a successful open', async () => {
    const { socket } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('uses the injected random function for full jitter', async () => {
    const { socket } = setup({
      reconnect: { minDelay: 1000, factor: 2, jitter: 'full', random: () => 0.25 },
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(249);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('goes to closed with a reason after maxAttempts failures', async () => {
    const { socket } = setup({
      reconnect: { minDelay: 10, jitter: 'none', maxAttempts: 2 },
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(10);
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(20);
    FakeWebSocket.last.serverClose();
    expect(socket.state).toBe('closed');
    expect(socket.closeReason).toBe('max-attempts');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('goes straight to closed when reconnect is false', async () => {
    const { socket } = setup({ reconnect: false });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(1001);
    expect(socket.state).toBe('closed');
    expect(socket.closeReason).toBe('connection-lost');
  });
});

describe('close()', () => {
  it('from idle: goes to closed and never connects', async () => {
    const { socket } = setup();
    socket.close();
    socket.connect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.state).toBe('closed');
    expect(socket.closeReason).toBe('closed-by-user');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('while the url provider is still pending: never opens a socket', async () => {
    let resolveUrl: (url: string) => void = () => undefined;
    const { socket } = setup({
      url: () => new Promise<string>((resolve) => (resolveUrl = resolve)),
    });
    socket.connect();
    socket.close();
    resolveUrl('wss://example.test/ws');
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(socket.state).toBe('closed');
  });

  it('while connecting: closes the underlying socket with the given code', async () => {
    const { socket } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.close(1000, 'bye');
    expect(FakeWebSocket.last.closeCalls).toEqual([{ code: 1000, reason: 'bye' }]);
    expect(socket.state).toBe('closed');
  });

  it('while open: ignores later events from the old socket', async () => {
    const { socket, states } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.last;
    ws.open();
    socket.close();
    ws.serverClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states.at(-1)).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('while reconnecting: cancels the pending retry', async () => {
    const { socket } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose();
    expect(socket.state).toBe('reconnecting');
    socket.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is terminal: connect() after close() does nothing', async () => {
    const { socket } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.close();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.state).toBe('closed');
  });
});

describe('send()', () => {
  it('serializes to JSON and sends while open', async () => {
    const { socket } = setup();
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    socket.send({ type: 'hello' });
    expect(FakeWebSocket.last.sent).toEqual(['{"type":"hello"}']);
  });

  it('throws by default while not open', async () => {
    const { socket } = setup();
    expect(() => {
      socket.send({ type: 'x' });
    }).toThrow(/idle/);
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(() => {
      socket.send({ type: 'x' });
    }).toThrow(/connecting/);
  });

  it('always throws once closed, even with queueWhileOffline', () => {
    const { socket } = setup({ queueWhileOffline: 5 });
    socket.close();
    expect(() => {
      socket.send({ type: 'x' });
    }).toThrow(/closed/);
  });

  it('with queueWhileOffline, buffers in order and flushes on open', async () => {
    const { socket } = setup({ queueWhileOffline: 2 });
    socket.send({ type: 'a' });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    socket.send({ type: 'b' });
    expect(() => {
      socket.send({ type: 'c' });
    }).toThrow(/queue is full/);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sent).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });

  it('with queueWhileOffline, keeps queued messages across a reconnect', async () => {
    const { socket } = setup({ queueWhileOffline: 5 });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose();
    socket.send({ type: 'late' });
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sent).toEqual(['{"type":"late"}']);
  });

  it('uses a custom serialize function', async () => {
    const { socket } = setup({ serialize: (m) => `custom:${m.type}` });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    socket.send({ type: 'x' });
    expect(FakeWebSocket.last.sent).toEqual(['custom:x']);
  });
});

describe('onMessage()', () => {
  it('parses JSON by default and notifies listeners', async () => {
    const { socket } = setup();
    const received: Msg[] = [];
    socket.onMessage((m) => received.push(m));
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    FakeWebSocket.last.receive('{"type":"event"}');
    expect(received).toEqual([{ type: 'event' }]);
  });

  it('stops notifying after unsubscribe', async () => {
    const { socket } = setup();
    const listener = vi.fn();
    const off = socket.onMessage(listener);
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    off();
    FakeWebSocket.last.receive('{"type":"event"}');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createSocket()', () => {
  it('accepts the global DOM WebSocket as the constructor type', () => {
    expectTypeOf<typeof WebSocket>().toExtend<WebSocketConstructor>();
  });

  it('throws a clear error when there is no WebSocket to use', () => {
    vi.stubGlobal('WebSocket', undefined);
    expect(() => createSocket({ url: 'wss://example.test' })).toThrow(/WebSocket/);
    vi.unstubAllGlobals();
  });
});
