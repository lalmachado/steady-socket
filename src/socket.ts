import { computeDelay, resolveReconnect } from './backoff';
import type {
  CloseReason,
  ConnectionState,
  Socket,
  SocketOptions,
  WebSocketConstructor,
  WebSocketLike,
} from './types';

export function createSocket<Incoming = unknown, Outgoing = unknown>(
  options: SocketOptions<Incoming, Outgoing>,
): Socket<Incoming, Outgoing> {
  const globalImpl = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  const WebSocketImpl = options.WebSocket ?? globalImpl;
  if (!WebSocketImpl) {
    throw new Error('No global WebSocket found. Pass one in with the `WebSocket` option.');
  }
  const connectWith: WebSocketConstructor = WebSocketImpl;

  const reconnect = options.reconnect === false ? undefined : resolveReconnect(options.reconnect);
  const serialize = options.serialize ?? ((message: Outgoing) => JSON.stringify(message));
  const parse = options.parse ?? ((data: unknown) => JSON.parse(String(data)) as Incoming);

  const stateListeners = new Set<(state: ConnectionState) => void>();
  const messageListeners = new Set<(message: Incoming) => void>();
  const queue: Outgoing[] = [];

  let state: ConnectionState = 'idle';
  let closeReason: CloseReason | undefined;
  let ws: WebSocketLike | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let failedAttempts = 0;
  // Bumped whenever the current attempt is abandoned, so late async results can tell they are stale.
  let generation = 0;

  function setState(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    for (const listener of [...stateListeners]) listener(state);
  }

  async function attempt(): Promise<void> {
    const mine = ++generation;
    setState('connecting');

    let url: string;
    try {
      url = typeof options.url === 'function' ? await options.url() : options.url;
    } catch {
      if (mine === generation) scheduleRetry();
      return;
    }
    if (mine !== generation) return;

    const socket = new connectWith(url, options.protocols);
    ws = socket;
    socket.addEventListener('open', () => {
      if (mine !== generation) return;
      failedAttempts = 0;
      setState('open');
      for (const message of queue.splice(0)) socket.send(serialize(message));
    });
    socket.addEventListener('message', (event) => {
      if (mine !== generation) return;
      const message = parse(event.data);
      for (const listener of [...messageListeners]) listener(message);
    });
    socket.addEventListener('close', () => {
      if (mine !== generation) return;
      ws = undefined;
      scheduleRetry();
    });
    // An `error` event is always followed by `close`, so there is nothing to do here.
    socket.addEventListener('error', () => undefined);
  }

  function scheduleRetry(): void {
    if (!reconnect) {
      stop('connection-lost');
      return;
    }
    if (failedAttempts >= reconnect.maxAttempts) {
      stop('max-attempts');
      return;
    }
    const delay = computeDelay(failedAttempts, reconnect);
    failedAttempts++;
    setState('reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void attempt();
    }, delay);
  }

  function stop(reason: CloseReason, code?: number, text?: string): void {
    generation++;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    queue.length = 0;
    ws?.close(code, text);
    ws = undefined;
    closeReason = reason;
    setState('closed');
  }

  return {
    get state() {
      return state;
    },
    get closeReason() {
      return closeReason;
    },
    connect() {
      if (state === 'idle') void attempt();
    },
    close(code, reason) {
      if (state !== 'closed') stop('closed-by-user', code, reason);
    },
    send(message) {
      if (state === 'open' && ws) {
        ws.send(serialize(message));
        return;
      }
      if (state === 'closed') throw new Error('Cannot send: the socket is closed.');
      const limit = options.queueWhileOffline;
      if (limit === undefined) {
        throw new Error(
          `Cannot send while the socket is ${state}. Set \`queueWhileOffline\` to buffer.`,
        );
      }
      if (queue.length >= limit)
        throw new Error(`Cannot send: the offline queue is full (${String(limit)}).`);
      queue.push(message);
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
  };
}
