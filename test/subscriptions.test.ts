import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { FakeWebSocket } from './helpers/fake-websocket';
import { setup, type Msg } from './helpers/setup';

// Topics travel as `{ type: 'subscribe' | 'unsubscribe' | 'event', topic }`.
type TopicMsg = Msg & { topic?: string };

const subscriptions = {
  subscribe: (topic: string): Msg => ({ type: 'subscribe', topic }) as TopicMsg,
  unsubscribe: (topic: string): Msg => ({ type: 'unsubscribe', topic }) as TopicMsg,
  topicOf: (m: Msg) => (m as TopicMsg).topic,
};

const sub = (topic: string) => JSON.stringify({ type: 'subscribe', topic });
const unsub = (topic: string) => JSON.stringify({ type: 'unsubscribe', topic });
const event = (topic: string, extra = {}) => JSON.stringify({ type: 'event', topic, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

async function connect(overrides = {}) {
  const ctx = setup({ subscriptions, ...overrides });
  ctx.socket.connect();
  await vi.advanceTimersByTimeAsync(0);
  return ctx;
}
async function connectAndOpen(overrides = {}) {
  const ctx = await connect(overrides);
  FakeWebSocket.last.open();
  await vi.advanceTimersByTimeAsync(0);
  return ctx;
}
async function reconnect() {
  FakeWebSocket.last.serverClose();
  await vi.advanceTimersByTimeAsync(1000);
  FakeWebSocket.last.open();
  await vi.advanceTimersByTimeAsync(0);
}

describe('reference counting', () => {
  it('sends one subscribe message however many listeners a topic has', async () => {
    const { socket } = await connectAndOpen();
    socket.subscribe('a', () => undefined);
    socket.subscribe('a', () => undefined);
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
  });

  it('sends unsubscribe only when the last listener leaves', async () => {
    const { socket } = await connectAndOpen();
    const off1 = socket.subscribe('a', () => undefined);
    const off2 = socket.subscribe('a', () => undefined);
    off1();
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
    off2();
    expect(FakeWebSocket.last.sent).toEqual([sub('a'), unsub('a')]);
  });

  it('is safe to call the returned function twice: it never removes another listener', async () => {
    const { socket } = await connectAndOpen();
    const off1 = socket.subscribe('a', () => undefined);
    const received = vi.fn();
    socket.subscribe('a', received);
    off1();
    off1();
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
    FakeWebSocket.last.receive(event('a'));
    expect(received).toHaveBeenCalledTimes(1);
  });

  it('counts the same handler subscribed twice as two listeners', async () => {
    const { socket } = await connectAndOpen();
    const handler = vi.fn();
    const off1 = socket.subscribe('a', handler);
    socket.subscribe('a', handler);
    off1();
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
    FakeWebSocket.last.receive(event('a'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('subscribes again from scratch after the last listener has left', async () => {
    const { socket } = await connectAndOpen();
    socket.subscribe('a', () => undefined)();
    socket.subscribe('a', () => undefined);
    expect(FakeWebSocket.last.sent).toEqual([sub('a'), unsub('a'), sub('a')]);
  });

  it('throws a clear error when the subscriptions option is missing', () => {
    const { socket } = setup();
    expect(() => socket.subscribe('a', () => undefined)).toThrow(/subscriptions/);
  });
});

describe('routing', () => {
  it('delivers a message only to the listeners of its topic', async () => {
    const { socket } = await connectAndOpen();
    const a = vi.fn();
    const b = vi.fn();
    socket.subscribe('a', a);
    socket.subscribe('b', b);
    FakeWebSocket.last.receive(event('a', { n: 1 }));
    expect(a).toHaveBeenCalledWith({ type: 'event', topic: 'a', n: 1 });
    expect(b).not.toHaveBeenCalled();
  });

  it('ignores messages with no topic or an unknown topic for subscribers, but still tells onMessage', async () => {
    const { socket } = await connectAndOpen();
    const a = vi.fn();
    const all = vi.fn();
    socket.subscribe('a', a);
    socket.onMessage(all);
    FakeWebSocket.last.receive('{"type":"hello"}');
    FakeWebSocket.last.receive(event('zzz'));
    expect(a).not.toHaveBeenCalled();
    expect(all).toHaveBeenCalledTimes(2);
  });

  it('stops delivering to a listener once it unsubscribes, even from inside a handler', async () => {
    const { socket } = await connectAndOpen();
    const second = vi.fn();
    const off1 = socket.subscribe('a', () => {
      off1();
    });
    socket.subscribe('a', second);
    FakeWebSocket.last.receive(event('a'));
    FakeWebSocket.last.receive(event('a'));
    expect(second).toHaveBeenCalledTimes(2);
  });
});

describe('while the socket is not open', () => {
  it('sends nothing before the socket opens, then sends the subscribe on open', async () => {
    const { socket } = await connect();
    socket.subscribe('a', () => undefined);
    expect(FakeWebSocket.last.sent).toEqual([]);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
  });

  it('can subscribe before connect() is called', async () => {
    const { socket } = setup({ subscriptions });
    socket.subscribe('a', () => undefined);
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
  });

  it('does not send unsubscribe, and does not replay, a topic that left while offline', async () => {
    const { socket } = await connectAndOpen();
    const off = socket.subscribe('a', () => undefined);
    socket.subscribe('b', () => undefined);
    FakeWebSocket.last.serverClose();
    off();
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sent).toEqual([sub('b')]);
  });

  it('sends a topic subscribed while reconnecting exactly once', async () => {
    const { socket } = await connectAndOpen();
    FakeWebSocket.last.serverClose();
    socket.subscribe('late', () => undefined);
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sent).toEqual([sub('late')]);
  });
});

describe('replay after reconnect', () => {
  it('re-sends every topic, in the order they were first subscribed', async () => {
    const { socket } = await connectAndOpen();
    socket.subscribe('b', () => undefined);
    socket.subscribe('a', () => undefined);
    socket.subscribe('c', () => undefined);
    socket.subscribe('b', () => undefined);
    await reconnect();
    expect(FakeWebSocket.last.sent).toEqual([sub('b'), sub('a'), sub('c')]);
    await reconnect();
    expect(FakeWebSocket.last.sent).toEqual([sub('b'), sub('a'), sub('c')]);
  });

  it('sends the onOpen messages first, then replay, then messages queued while offline', async () => {
    const { socket } = await connectAndOpen({
      queueWhileOffline: 5,
      onOpen: (send: (m: Msg) => void) => {
        send({ type: 'auth' });
      },
    });
    socket.subscribe('a', () => undefined);
    socket.subscribe('b', () => undefined);
    FakeWebSocket.last.serverClose();
    socket.send({ type: 'queued' });
    await vi.advanceTimersByTimeAsync(1000);
    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.last.sent).toEqual([
      '{"type":"auth"}',
      sub('a'),
      sub('b'),
      '{"type":"queued"}',
    ]);
  });

  it('waits for an async onOpen before replaying', async () => {
    let finishAuth: () => void = () => undefined;
    const { socket } = await connect({
      onOpen: () =>
        new Promise<void>((resolve) => {
          finishAuth = resolve;
        }),
    });
    socket.subscribe('a', () => undefined);
    FakeWebSocket.last.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.last.sent).toEqual([]);
    finishAuth();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
  });

  it('does not replay a subscription twice when a state listener subscribes on open', async () => {
    const { socket } = await connect();
    socket.subscribe('a', () => undefined);
    socket.onState((state) => {
      if (state === 'open') socket.subscribe('from-listener', () => undefined);
    });
    FakeWebSocket.last.open();
    expect(FakeWebSocket.last.sent).toEqual([sub('a'), sub('from-listener')]);
  });

  it('keeps delivering to the same listeners on the new connection', async () => {
    const { socket } = await connectAndOpen();
    const handler = vi.fn();
    socket.subscribe('a', handler);
    await reconnect();
    FakeWebSocket.last.receive(event('a'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('close()', () => {
  it('forgets all topics: a returned unsubscribe function afterwards does nothing', async () => {
    const { socket } = await connectAndOpen();
    const off = socket.subscribe('a', () => undefined);
    socket.close();
    expect(() => {
      off();
    }).not.toThrow();
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
  });

  it('subscribe() after close() is a no-op', async () => {
    const { socket } = await connectAndOpen();
    socket.close();
    const off = socket.subscribe('a', () => undefined);
    off();
    expect(FakeWebSocket.last.sent).toEqual([]);
  });
});

describe('types', () => {
  it('flows the Incoming and Outgoing generics through the API', () => {
    const { socket } = setup();
    type S = typeof socket;
    expectTypeOf<Parameters<S['send']>[0]>().toEqualTypeOf<Msg>();
    expectTypeOf<Parameters<Parameters<S['onMessage']>[0]>[0]>().toEqualTypeOf<Msg>();
    expectTypeOf<Parameters<Parameters<S['subscribe']>[1]>[0]>().toEqualTypeOf<Msg>();
    const sendWrongType = () => {
      // @ts-expect-error a string is not an Outgoing message
      socket.send('nope');
    };
    expect(sendWrongType).toBeInstanceOf(Function);
  });
});
