import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from './helpers/fake-websocket';
import { setup, type Msg } from './helpers/setup';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('onOpen', () => {
  it('runs on every connection, before the socket counts as open', async () => {
    const calls: string[] = [];
    const { socket } = setup({
      onOpen: (send) => {
        calls.push(`onOpen:${socket.state}`);
        send({ type: 'auth' });
      },
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    expect(calls).toEqual(['onOpen:connecting']);
    expect(socket.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('open');

    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['onOpen:connecting', 'onOpen:connecting']);
  });

  it('sends its messages before anything queued with queueWhileOffline', async () => {
    const { socket } = setup({
      queueWhileOffline: 5,
      onOpen: (send) => {
        send({ type: 'auth' });
      },
    });
    socket.send({ type: 'queued' });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.last.sent).toEqual(['{"type":"auth"}', '{"type":"queued"}']);
  });

  it('waits for an async onOpen before going to open and flushing', async () => {
    const gate = deferred();
    const { socket } = setup({
      queueWhileOffline: 5,
      onOpen: async (send) => {
        await gate.promise;
        send({ type: 'auth' });
      },
    });
    socket.send({ type: 'queued' });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    expect(socket.state).toBe('connecting');
    expect(FakeWebSocket.last.sent).toEqual([]);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('open');
    expect(FakeWebSocket.last.sent).toEqual(['{"type":"auth"}', '{"type":"queued"}']);
  });

  it('delivers messages that arrive while onOpen is still running', async () => {
    const gate = deferred();
    const { socket } = setup({ onOpen: () => gate.promise });
    const received: Msg[] = [];
    socket.onMessage((m) => received.push(m));
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    FakeWebSocket.last.receive('{"type":"auth-ok"}');
    expect(received).toEqual([{ type: 'auth-ok' }]);
  });

  it('drops the connection and retries when onOpen rejects', async () => {
    let calls = 0;
    const { socket } = setup({
      onOpen: () => {
        if (++calls === 1) return Promise.reject(new Error('no token'));
        return undefined;
      },
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeWebSocket.last;
    first.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.closeCalls).toEqual([{ code: 4001, reason: 'onOpen failed' }]);
    expect(socket.state).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('open');
  });

  it('never goes to open if the connection drops while onOpen is running', async () => {
    const gate = deferred();
    const { socket, states } = setup({ onOpen: () => gate.promise });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['connecting', 'reconnecting']);
  });

  it('never goes to open if close() is called while onOpen is running', async () => {
    const gate = deferred();
    const { socket } = setup({ onOpen: () => gate.promise });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    socket.close();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('closed');
  });

  it('ignores send() calls made after the connection it belongs to is gone', async () => {
    let lateSend: (message: Msg) => void = () => undefined;
    const { socket } = setup({
      onOpen: (send) => {
        lateSend = send;
      },
    });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeWebSocket.last;
    first.open();
    first.serverClose();
    lateSend({ type: 'stale' });
    expect(first.sent).toEqual([]);
  });
});

describe('isAuthFailure', () => {
  const isAuthFailure = (event: { code: number }) => event.code === 4401;

  it('goes to closed with a reason and stops retrying', async () => {
    const { socket, states } = setup({ isAuthFailure });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(4401, 'token expired');
    expect(socket.state).toBe('closed');
    expect(socket.closeReason).toBe('auth-failure');
    expect(states).toEqual(['connecting', 'open', 'closed']);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('also stops when the server rejects before the socket ever opens', async () => {
    const { socket } = setup({ isAuthFailure });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose(4401);
    expect(socket.state).toBe('closed');
    expect(socket.closeReason).toBe('auth-failure');
  });

  it('stops when the server rejects while onOpen is running', async () => {
    const gate = deferred();
    const { socket } = setup({ isAuthFailure, onOpen: () => gate.promise });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(4401);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.closeReason).toBe('auth-failure');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('keeps reconnecting for close codes that are not auth failures', async () => {
    const { socket } = setup({ isAuthFailure });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose(1006);
    expect(socket.state).toBe('reconnecting');
  });
});
