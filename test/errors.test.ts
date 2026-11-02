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

const subscriptions = {
  subscribe: (topic: string): Msg => ({ type: `sub:${topic}` }),
  unsubscribe: (topic: string): Msg => ({ type: `unsub:${topic}` }),
  topicOf: (message: Msg & { topic?: string }) => message.topic,
};

async function openSocket(overrides: Parameters<typeof setup>[0] = {}) {
  const result = setup(overrides);
  result.socket.connect();
  await vi.advanceTimersByTimeAsync(0);
  FakeWebSocket.last.open();
  return result;
}

describe('errors in what you give the socket do not break the socket', () => {
  it('a message that cannot be parsed goes to onError, and the next message still arrives', async () => {
    const onError = vi.fn();
    const { socket } = await openSocket({ onError });
    const received: Msg[] = [];
    socket.onMessage((message) => received.push(message));

    FakeWebSocket.last.receive('this is not json');
    FakeWebSocket.last.receive(JSON.stringify({ type: 'hello' }));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(SyntaxError);
    expect(received).toEqual([{ type: 'hello' }]);
    expect(socket.state).toBe('open');
  });

  it('a listener that throws does not stop the others from getting the message', async () => {
    const boom = new Error('boom');
    const onError = vi.fn();
    const { socket } = await openSocket({ onError });
    const received: string[] = [];
    socket.onMessage(() => {
      throw boom;
    });
    socket.onMessage(() => received.push('second listener'));

    FakeWebSocket.last.receive(JSON.stringify({ type: 'hello' }));

    expect(received).toEqual(['second listener']);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('a subscription handler that throws does not stop the other handlers of the topic', async () => {
    const boom = new Error('boom');
    const onError = vi.fn();
    const { socket } = await openSocket({ onError, subscriptions });
    const received: string[] = [];
    socket.subscribe('t', () => {
      throw boom;
    });
    socket.subscribe('t', () => received.push('second handler'));

    FakeWebSocket.last.receive(JSON.stringify({ type: 'event', topic: 't' }));
    FakeWebSocket.last.receive(JSON.stringify({ type: 'event', topic: 't' }));

    expect(received).toEqual(['second handler', 'second handler']);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('isPong or topicOf throwing still delivers the message', async () => {
    const boom = new Error('boom');
    const onError = vi.fn();
    const { socket } = await openSocket({
      onError,
      heartbeat: {
        interval: 10_000,
        timeout: 1_000,
        ping: () => ({ type: 'ping' }),
        isPong: () => {
          throw boom;
        },
      },
    });
    const received: Msg[] = [];
    socket.onMessage((message) => received.push(message));

    FakeWebSocket.last.receive(JSON.stringify({ type: 'hello' }));

    expect(received).toEqual([{ type: 'hello' }]);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('a state listener that throws does not stop the others, or the heartbeat from starting', async () => {
    const boom = new Error('boom');
    const onError = vi.fn();
    const { socket } = setup({
      onError,
      heartbeat: {
        interval: 5_000,
        timeout: 1_000,
        ping: () => ({ type: 'ping' }),
        isPong: (message) => message.type === 'pong',
      },
    });
    const seen: string[] = [];
    socket.onState(() => {
      throw boom;
    });
    socket.onState((state) => seen.push(state));

    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(seen).toContain('open');
    expect(FakeWebSocket.last.sent).toContain(JSON.stringify({ type: 'ping' }));
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('without onError the error is rethrown later, so it is not swallowed, and nothing else is affected', async () => {
    const { socket } = await openSocket();
    const received: Msg[] = [];
    socket.onMessage((message) => received.push(message));

    FakeWebSocket.last.receive('this is not json');
    FakeWebSocket.last.receive(JSON.stringify({ type: 'hello' }));

    expect(received).toEqual([{ type: 'hello' }]); // delivered right away
    expect(() => vi.advanceTimersByTime(0)).toThrow(SyntaxError); // and the error is not lost
    expect(socket.state).toBe('open');
  });

  it('an onError that throws is not allowed to break the socket either', async () => {
    const { socket } = await openSocket({
      onError: () => {
        throw new Error('onError itself failed');
      },
    });
    const received: Msg[] = [];
    socket.onMessage((message) => received.push(message));

    FakeWebSocket.last.receive('this is not json');
    FakeWebSocket.last.receive(JSON.stringify({ type: 'hello' }));

    expect(received).toEqual([{ type: 'hello' }]);
    expect(() => vi.advanceTimersByTime(0)).toThrow('onError itself failed');
  });
});
