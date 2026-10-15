// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocketProvider, useSocket, useSocketState, useSubscription } from '../src/react';
import { FakeWebSocket } from './helpers/fake-websocket';
import { setup, type Msg } from './helpers/setup';

type TopicMsg = Msg & { topic?: string };
const subscriptions = {
  subscribe: (topic: string): Msg => ({ type: 'subscribe', topic }) as TopicMsg,
  unsubscribe: (topic: string): Msg => ({ type: 'unsubscribe', topic }) as TopicMsg,
  topicOf: (m: Msg) => (m as TopicMsg).topic,
};
const sub = (topic: string) => JSON.stringify({ type: 'subscribe', topic });
const unsub = (topic: string) => JSON.stringify({ type: 'unsubscribe', topic });
const event = (topic: string, n = 0) => JSON.stringify({ type: 'event', topic, n });

function openSocket() {
  const { socket } = setup({ subscriptions });
  socket.connect();
  act(() => {
    FakeWebSocket.last.open();
  });
  return socket;
}

beforeEach(() => {
  FakeWebSocket.reset();
});
afterEach(() => {
  cleanup();
});

describe('useSocket', () => {
  it('throws a clear error outside a SocketProvider', () => {
    function Bad() {
      useSocket();
      return null;
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Bad />)).toThrow(/SocketProvider/);
    error.mockRestore();
  });

  it('returns the socket given to the provider', () => {
    const { socket } = setup();
    let seen: unknown;
    function Probe() {
      seen = useSocket();
      return null;
    }
    render(
      <SocketProvider socket={socket}>
        <Probe />
      </SocketProvider>,
    );
    expect(seen).toBe(socket);
  });
});

describe('useSocketState', () => {
  function State() {
    return <p>{useSocketState()}</p>;
  }

  it('shows the current state and follows every transition', () => {
    const { socket } = setup({ reconnect: { minDelay: 1000, jitter: 'none' } });
    render(
      <SocketProvider socket={socket}>
        <State />
      </SocketProvider>,
    );
    expect(screen.getByText('idle')).toBeTruthy();
    act(() => {
      socket.connect();
    });
    expect(screen.getByText('connecting')).toBeTruthy();
    act(() => {
      FakeWebSocket.last.open();
    });
    expect(screen.getByText('open')).toBeTruthy();
    act(() => {
      FakeWebSocket.last.serverClose();
    });
    expect(screen.getByText('reconnecting')).toBeTruthy();
    act(() => {
      socket.close();
    });
    expect(screen.getByText('closed')).toBeTruthy();
  });

  it('shows the state the socket already has when the component mounts', () => {
    const socket = openSocket();
    render(
      <SocketProvider socket={socket}>
        <State />
      </SocketProvider>,
    );
    expect(screen.getByText('open')).toBeTruthy();
  });

  it('does not re-render when something other than the state changes', () => {
    const socket = openSocket();
    let renders = 0;
    function Counting() {
      renders++;
      return <p>{useSocketState()}</p>;
    }
    render(
      <SocketProvider socket={socket}>
        <Counting />
      </SocketProvider>,
    );
    const before = renders;
    act(() => {
      FakeWebSocket.last.receive('{"type":"event"}');
    });
    expect(renders).toBe(before);
  });

  it('stops listening when the component unmounts', () => {
    const { socket } = setup();
    const { unmount } = render(
      <SocketProvider socket={socket}>
        <State />
      </SocketProvider>,
    );
    unmount();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() => {
      socket.connect();
    });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('renders "idle" on the server, whatever the socket is doing', () => {
    const socket = openSocket();
    const html = renderToString(
      <SocketProvider socket={socket}>
        <State />
      </SocketProvider>,
    );
    expect(html).toContain('idle');
  });
});

describe('useSubscription', () => {
  function Listener({ topic, onMessage }: { topic: string; onMessage: (m: Msg) => void }) {
    useSubscription<Msg>(topic, onMessage);
    return null;
  }

  it('subscribes on mount and unsubscribes on unmount', () => {
    const socket = openSocket();
    const { unmount } = render(
      <SocketProvider socket={socket}>
        <Listener topic="a" onMessage={() => undefined} />
      </SocketProvider>,
    );
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
    unmount();
    expect(FakeWebSocket.last.sent).toEqual([sub('a'), unsub('a')]);
  });

  it('delivers messages for its topic to the handler', () => {
    const socket = openSocket();
    const onMessage = vi.fn();
    render(
      <SocketProvider socket={socket}>
        <Listener topic="a" onMessage={onMessage} />
      </SocketProvider>,
    );
    act(() => {
      FakeWebSocket.last.receive(event('a', 1));
      FakeWebSocket.last.receive(event('b', 2));
    });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith({ type: 'event', topic: 'a', n: 1 });
  });

  it('does not resubscribe when a new handler is passed on every render, and calls the latest', () => {
    const socket = openSocket();
    const seen: string[] = [];
    function Counter() {
      const [count, setCount] = useState(0);
      // A brand new function on every render.
      useSubscription<Msg>('a', () => {
        seen.push(`count=${String(count)}`);
      });
      return (
        <button
          onClick={() => {
            setCount(count + 1);
          }}
        >
          inc
        </button>
      );
    }
    render(
      <SocketProvider socket={socket}>
        <Counter />
      </SocketProvider>,
    );
    act(() => {
      screen.getByText('inc').click();
    });
    act(() => {
      screen.getByText('inc').click();
    });
    act(() => {
      FakeWebSocket.last.receive(event('a'));
    });
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
    expect(seen).toEqual(['count=2']);
  });

  it('moves to the new topic when the topic changes', () => {
    const socket = openSocket();
    const onMessage = vi.fn();
    const { rerender } = render(
      <SocketProvider socket={socket}>
        <Listener topic="a" onMessage={onMessage} />
      </SocketProvider>,
    );
    rerender(
      <SocketProvider socket={socket}>
        <Listener topic="b" onMessage={onMessage} />
      </SocketProvider>,
    );
    expect(FakeWebSocket.last.sent).toEqual([sub('a'), unsub('a'), sub('b')]);
  });

  it('shares one server subscription between components on the same topic', () => {
    const socket = openSocket();
    const first = vi.fn();
    const second = vi.fn();
    function Both({ showSecond }: { showSecond: boolean }) {
      return (
        <SocketProvider socket={socket}>
          <Listener topic="a" onMessage={first} />
          {showSecond && <Listener topic="a" onMessage={second} />}
        </SocketProvider>
      );
    }
    const { rerender } = render(<Both showSecond />);
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
    rerender(<Both showSecond={false} />);
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
    act(() => {
      FakeWebSocket.last.receive(event('a'));
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('works before the socket is open: subscribes when it opens', () => {
    const { socket } = setup({ subscriptions });
    render(
      <SocketProvider socket={socket}>
        <Listener topic="a" onMessage={() => undefined} />
      </SocketProvider>,
    );
    socket.connect();
    act(() => {
      FakeWebSocket.last.open();
    });
    expect(FakeWebSocket.last.sent).toEqual([sub('a')]);
  });

  it('is safe under React Strict Mode: one live listener, handler called once per message', () => {
    const socket = openSocket();
    const onMessage = vi.fn();
    render(
      <StrictMode>
        <SocketProvider socket={socket}>
          <Listener topic="a" onMessage={onMessage} />
        </SocketProvider>
      </StrictMode>,
    );
    // Strict Mode mounts, unmounts and mounts again, so the topic is subscribed twice in total...
    const sent = FakeWebSocket.last.sent;
    expect(sent.at(-1)).toBe(sub('a'));
    expect(
      sent.filter((m) => m === sub('a')).length - sent.filter((m) => m === unsub('a')).length,
    ).toBe(1);
    // ...but only one listener is left, so a message is delivered exactly once.
    act(() => {
      FakeWebSocket.last.receive(event('a'));
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('moves to the new socket when the provider is given a different one', () => {
    const first = openSocket();
    const firstWs = FakeWebSocket.last;
    const { socket: second } = setup({ subscriptions });
    second.connect();
    const secondWs = FakeWebSocket.last;
    act(() => {
      secondWs.open();
    });
    const { rerender } = render(
      <SocketProvider socket={first}>
        <Listener topic="a" onMessage={() => undefined} />
      </SocketProvider>,
    );
    rerender(
      <SocketProvider socket={second}>
        <Listener topic="a" onMessage={() => undefined} />
      </SocketProvider>,
    );
    expect(firstWs.sent).toEqual([sub('a'), unsub('a')]);
    expect(secondWs.sent).toEqual([sub('a')]);
  });
});
