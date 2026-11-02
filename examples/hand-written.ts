/**
 * What it takes to get the behaviour of `steady-socket` by hand on a plain WebSocket:
 *
 *  - reconnect with exponential backoff and jitter
 *  - a fresh token on every connection
 *  - a heartbeat that notices a connection that is open but dead
 *  - subscriptions that are sent again after every reconnect
 *  - stop for good when the server rejects the login (close code 4401)
 *  - reconnect straight away when the page comes back or the network returns
 *
 * It is written to be correct, not to be short, and it is tested against the demo server with the
 * same scenarios as `steady-socket` (apps/demo-server/test/hand-written.test.ts). Compare it with
 * examples/with-steady-socket.ts, which does the same with the library.
 */

export interface Message {
  type: string;
  topic?: string;
  payload?: unknown;
}

export interface HandWrittenOptions {
  /** `wss://…`, without the token. */
  url: string;
  getToken: () => Promise<string>;
  /** Pass `ws` in Node. */
  WebSocket?: typeof WebSocket;
  pingEveryMs?: number;
  pongTimeoutMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export function createHandWrittenSocket(options: HandWrittenOptions) {
  const {
    url,
    getToken,
    WebSocket: Socket = WebSocket,
    pingEveryMs = 15_000,
    pongTimeoutMs = 5_000,
    minDelayMs = 500,
    maxDelayMs = 30_000,
  } = options;

  const handlers = new Map<string, Set<(message: Message) => void>>();
  let socket: WebSocket | undefined;
  let open = false;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (message: Message): void => {
    if (open) socket?.send(JSON.stringify(message));
  };

  const stopTimers = (): void => {
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
  };

  /** Give up on a socket without waiting for its `close` event: a dead one may never send it. */
  const abandon = (dead: WebSocket): void => {
    if (dead !== socket) return;
    socket = undefined;
    open = false;
    stopTimers();
    dead.onopen = dead.onmessage = dead.onclose = null;
    dead.onerror = () => undefined; // `ws` throws on an error nobody listens to
    dead.close();
    scheduleReconnect();
  };

  const ping = (target: WebSocket): void => {
    send({ type: 'ping' });
    clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      abandon(target);
    }, pongTimeoutMs);
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    // Full jitter: a random delay up to the exponential ceiling.
    const ceiling = Math.min(maxDelayMs, minDelayMs * 2 ** attempt++);
    retryTimer = setTimeout(() => void connect(), Math.random() * ceiling);
  };

  const connect = async (): Promise<void> => {
    clearTimeout(retryTimer);
    let token: string;
    try {
      token = await getToken();
    } catch {
      scheduleReconnect();
      return;
    }
    if (closed) return; // closed while the token was being fetched
    const fresh = new Socket(`${url}/?token=${token}`);
    socket = fresh;
    fresh.onopen = () => {
      open = true;
      attempt = 0;
      for (const topic of handlers.keys()) send({ type: 'subscribe', topic });
      pingTimer = setInterval(() => {
        ping(fresh);
      }, pingEveryMs);
    };
    fresh.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as Message;
      if (message.type === 'pong') {
        clearTimeout(pongTimer);
        return;
      }
      if (message.topic !== undefined) {
        for (const handler of handlers.get(message.topic) ?? []) handler(message);
      }
    };
    // A failed connection is always followed by `close`, which does the work. But `ws` in Node
    // throws, and takes the process down, if nobody listens for `error`.
    fresh.onerror = () => undefined;
    fresh.onclose = (event: CloseEvent) => {
      if (fresh !== socket) return; // an old socket closing late
      socket = undefined;
      open = false;
      stopTimers();
      if (event.code === 4401)
        closed = true; // bad credentials: retrying would not help
      else scheduleReconnect();
    };
  };

  /** Back from the background, or the network is back: do not wait for the next retry. */
  const wake = (): void => {
    if (closed) return;
    if (socket === undefined) void connect();
    else if (open) ping(socket);
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake();
    });
  }

  return {
    connect: () => void connect(),
    close: (): void => {
      closed = true;
      stopTimers();
      socket?.close();
      socket = undefined;
      open = false;
    },
    subscribe(topic: string, handler: (message: Message) => void): () => void {
      const set = handlers.get(topic) ?? new Set();
      if (set.size === 0) send({ type: 'subscribe', topic });
      set.add(handler);
      handlers.set(topic, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) {
          handlers.delete(topic);
          send({ type: 'unsubscribe', topic });
        }
      };
    },
    get state(): 'connecting' | 'open' | 'closed' {
      return closed ? 'closed' : open ? 'open' : 'connecting';
    },
  };
}
