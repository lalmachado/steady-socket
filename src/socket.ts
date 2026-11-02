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
  // One entry per subscribe() call, so the same handler subscribed twice counts as two listeners.
  // A Map iterates in insertion order, which is the order topics are replayed in.
  const topics = new Map<string, Set<{ handler: (message: Incoming) => void }>>();

  let state: ConnectionState = 'idle';
  let closeReason: CloseReason | undefined;
  let ws: WebSocketLike | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let uptimeTimer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  let pingNow: (() => void) | undefined;
  let detachLifecycle: (() => void) | undefined;
  let failedAttempts = 0;
  // Bumped whenever the current attempt is abandoned, so late async results can tell they are stale.
  let generation = 0;

  /**
   * Something the caller gave us failed. The connection is fine, so it must not suffer: report the
   * error and carry on. Left to propagate, an exception from a message listener leaves the socket
   * "open" but deaf (the `ws` package stops reading), and one from a state listener would stop
   * `open` from ever starting the heartbeat.
   */
  function reportError(error: unknown): void {
    if (options.onError) {
      try {
        options.onError(error);
        return;
      } catch (onErrorError) {
        error = onErrorError; // the handler itself failed: surface that, below
      }
    }
    setTimeout(() => {
      throw error;
    }, 0);
  }

  /** Runs `fn`, reporting an exception instead of throwing it. Returns what `fn` returned, if it did. */
  function guarded<T>(fn: () => T): { value: T } | undefined {
    try {
      return { value: fn() };
    } catch (error) {
      reportError(error);
      return undefined;
    }
  }

  function setState(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    for (const listener of [...stateListeners]) {
      guarded(() => {
        listener(state);
      });
    }
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
      void handleOpen(socket, mine);
    });
    socket.addEventListener('message', (event) => {
      if (mine !== generation) return;
      const parsed = guarded(() => parse(event.data));
      if (!parsed) return; // unreadable: reported, and the next message is unaffected
      const message = parsed.value;
      if (guarded(() => options.heartbeat?.isPong(message) === true)?.value) {
        clearTimeout(pongTimer);
        pongTimer = undefined;
        return;
      }
      for (const listener of [...messageListeners]) {
        guarded(() => {
          listener(message);
        });
      }
      const topic = guarded(() => options.subscriptions?.topicOf(message))?.value;
      if (topic !== undefined) {
        for (const entry of [...(topics.get(topic) ?? [])]) {
          guarded(() => {
            entry.handler(message);
          });
        }
      }
    });
    socket.addEventListener('close', (event) => {
      if (mine !== generation) return;
      // This attempt is over. Bumping the generation also cancels an `onOpen` still in flight.
      generation++;
      stopHeartbeat();
      ws = undefined;
      if (options.isAuthFailure?.(event)) stop('auth-failure');
      else scheduleRetry();
    });
    // An `error` event is always followed by `close`, so there is nothing to do here.
    socket.addEventListener('error', () => undefined);
  }

  async function handleOpen(socket: WebSocketLike, mine: number): Promise<void> {
    if (mine !== generation) return;
    // Without `onOpen` there is no `await`, so this part runs synchronously.
    if (options.onOpen) {
      try {
        await options.onOpen((message) => {
          if (mine === generation) socket.send(serialize(message));
        });
      } catch {
        if (mine === generation) abandon(socket, 4001, 'onOpen failed');
        return;
      }
      if (mine !== generation) return;
    }
    // The connection counts as a success (and the backoff starts over) only once it has stayed up
    // for `minUptime`. Resetting on `open` alone would retry a server that accepts connections and
    // drops them at once at the shortest delay for ever.
    if (!reconnect || reconnect.minUptime <= 0) failedAttempts = 0;
    else {
      uptimeTimer = setTimeout(() => {
        if (mine === generation) failedAttempts = 0;
      }, reconnect.minUptime);
    }
    // Everything goes out before `open` is announced, so a state listener that calls send() or
    // subscribe() cannot jump ahead of replay or the queue (or be replayed twice).
    // Order: onOpen (auth) → replayed subscriptions → messages queued while offline.
    if (options.subscriptions) {
      for (const topic of topics.keys()) {
        socket.send(serialize(options.subscriptions.subscribe(topic)));
      }
    }
    for (const message of queue.splice(0)) socket.send(serialize(message));
    setState('open');
    startHeartbeat(socket, mine);
  }

  function startHeartbeat(socket: WebSocketLike, mine: number): void {
    const heartbeat = options.heartbeat;
    if (!heartbeat) return;
    pingNow = () => {
      // A ping is still waiting for its pong: do not stack another one on top.
      if (pongTimer !== undefined) return;
      socket.send(serialize(heartbeat.ping()));
      pongTimer = setTimeout(() => {
        if (mine === generation) abandon(socket, 4000, 'heartbeat timeout');
      }, heartbeat.timeout);
    };
    pingTimer = setInterval(pingNow, heartbeat.interval);
  }

  /** Stops the timers that belong to one connection: the heartbeat and the uptime check. */
  function stopHeartbeat(): void {
    clearTimeout(uptimeTimer);
    uptimeTimer = undefined;
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    pingTimer = undefined;
    pongTimer = undefined;
    pingNow = undefined;
  }

  /**
   * Gives up on a connection that is still nominally open (dead heartbeat, failed `onOpen`) and
   * retries. A dead socket may never emit `close`, so we do not wait for it: the generation bump
   * makes any late events from it irrelevant.
   */
  function abandon(socket: WebSocketLike, code: number, reason: string): void {
    generation++;
    stopHeartbeat();
    ws = undefined;
    socket.close(code, reason);
    scheduleRetry();
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
    setState('reconnecting');
    // Paused (offline): wait here without using up an attempt. wake() connects.
    if (paused) return;
    const delay = computeDelay(failedAttempts, reconnect);
    failedAttempts++;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void attempt();
    }, delay);
  }

  function stop(reason: CloseReason, code?: number, text?: string): void {
    generation++;
    stopHeartbeat();
    clearTimeout(retryTimer);
    retryTimer = undefined;
    queue.length = 0;
    topics.clear();
    detachLifecycle?.();
    detachLifecycle = undefined;
    ws?.close(code, text);
    ws = undefined;
    closeReason = reason;
    setState('closed');
  }

  function pause(): void {
    paused = true;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function wake(): void {
    paused = false;
    if (state === 'reconnecting') {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      void attempt();
    } else if (state === 'open') {
      pingNow?.();
    }
  }

  return {
    get state() {
      return state;
    },
    get closeReason() {
      return closeReason;
    },
    connect() {
      if (state !== 'idle') return;
      detachLifecycle = options.lifecycle?.({ pause, wake });
      void attempt();
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
    subscribe(topic, handler) {
      const subscriptions = options.subscriptions;
      if (!subscriptions) {
        throw new Error('Cannot subscribe: set the `subscriptions` option first.');
      }
      if (state === 'closed') return () => undefined;

      const entry = { handler };
      let listeners = topics.get(topic);
      if (!listeners) {
        listeners = new Set();
        topics.set(topic, listeners);
        // Not open yet: the topic is in the map, so replay sends it when the socket opens.
        if (state === 'open' && ws) ws.send(serialize(subscriptions.subscribe(topic)));
      }
      listeners.add(entry);

      return () => {
        // Look the set up again: after close() or a re-subscribe it may not be the same one.
        const current = topics.get(topic);
        if (!current?.delete(entry) || current.size > 0) return;
        topics.delete(topic);
        if (state === 'open' && ws) ws.send(serialize(subscriptions.unsubscribe(topic)));
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
