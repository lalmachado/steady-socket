import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from './helpers/fake-websocket';
import { setup } from './helpers/setup';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

const reconnect = (extra: { minUptime?: number; maxAttempts?: number } = {}) => ({
  reconnect: { minDelay: 1000, maxDelay: 8000, factor: 2, jitter: 'none' as const, ...extra },
});

/** Connects, then drops the first connection, so the second attempt is a retry. */
async function afterFirstDrop(extra: { minUptime?: number; maxAttempts?: number } = {}) {
  const result = setup(reconnect(extra));
  result.socket.connect();
  await vi.advanceTimersByTimeAsync(0);
  FakeWebSocket.last.serverClose(); // retry 1 is due in 1000 ms
  await vi.advanceTimersByTimeAsync(1000);
  expect(FakeWebSocket.instances).toHaveLength(2);
  return result;
}

describe('minUptime: a connection must stay up before it counts as a success', () => {
  it('a connection that opens and drops at once does not reset the backoff', async () => {
    await afterFirstDrop();

    // The second connection opens and is dropped straight away (a server that accepts and hangs up).
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeWebSocket.instances).toHaveLength(2); // the wait is 2000 ms, not 1000 again
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(3999);
    expect(FakeWebSocket.instances).toHaveLength(3); // and 4000 ms after that
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('a connection that stays open for minUptime resets the backoff', async () => {
    await afterFirstDrop();

    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(5000);
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(3); // back to the first, short, wait
  });

  it('dropping a moment before minUptime still counts as a flap', async () => {
    await afterFirstDrop();

    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(4999);
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('minUptime: 0 resets as soon as the connection opens', async () => {
    await afterFirstDrop({ minUptime: 0 });

    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('connections that open and drop count towards maxAttempts', async () => {
    const { socket } = await afterFirstDrop({ maxAttempts: 3 });

    // Retries 1 to 3 were each followed by a connection that opened and dropped.
    for (const wait of [2000, 4000]) {
      FakeWebSocket.last.open();
      FakeWebSocket.last.serverClose();
      await vi.advanceTimersByTimeAsync(wait);
    }
    expect(socket.state).toBe('connecting'); // the third retry, not yet opened
    FakeWebSocket.last.open();
    FakeWebSocket.last.serverClose();

    expect(socket.state).toBe('closed');
    expect(socket.closeReason).toBe('max-attempts');
  });

  it('closing the socket cancels the pending reset', async () => {
    const { socket } = await afterFirstDrop();
    FakeWebSocket.last.open();
    socket.close();
    await expect(vi.advanceTimersByTimeAsync(10_000)).resolves.not.toThrow();
    expect(socket.state).toBe('closed');
  });
});
