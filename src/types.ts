export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Why a socket ended up in `closed`. */
export type CloseReason = 'closed-by-user' | 'connection-lost' | 'max-attempts' | 'auth-failure';

/** The subset of the `WebSocket` API this library relies on. Browsers, React Native and `ws` all fit. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: CloseInfo) => void): void;
}

export type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

export interface ReconnectOptions {
  /** Delay ceiling for the first retry, in ms. Default 500. */
  minDelay?: number;
  /** The delay ceiling never grows past this, in ms. Default 30 000. */
  maxDelay?: number;
  /** The ceiling is multiplied by this after every failed attempt. Default 2. */
  factor?: number;
  /** `'full'` waits a random time between 0 and the ceiling; `'none'` waits exactly the ceiling. Default `'full'`. */
  jitter?: 'full' | 'none';
  /** Give up and go to `closed` after this many consecutive failed attempts. Default: never. */
  maxAttempts?: number;
  /** Returns a number in [0, 1). Replace it in tests to make jitter deterministic. Default `Math.random`. */
  random?: () => number;
}

export interface CloseInfo {
  code: number;
  reason: string;
}

export interface HeartbeatOptions<Incoming, Outgoing> {
  /** Send a ping this often while the socket is open, in ms. */
  interval: number;
  /** If no pong arrives within this many ms of a ping, the socket is treated as dead, in ms. */
  timeout: number;
  ping: () => Outgoing;
  /** Pongs are consumed by the heartbeat and are not passed to `onMessage` listeners. */
  isPong: (message: Incoming) => boolean;
}

export interface SubscriptionOptions<Incoming, Outgoing> {
  /** The message that tells the server to start sending a topic. */
  subscribe: (topic: string) => Outgoing;
  /** The message that tells the server to stop sending a topic. */
  unsubscribe: (topic: string) => Outgoing;
  /** Which topic an incoming message belongs to, or `undefined` if it belongs to none. */
  topicOf: (message: Incoming) => string | undefined;
}

/** What a lifecycle adapter can ask the socket to do. */
export interface LifecycleControls {
  /** Stop scheduling reconnect attempts, for example because the device is offline. */
  pause: () => void;
  /**
   * Un-pause, and get connected now: skip any backoff wait and connect straight away, or, if the
   * socket is open, ping straight away to check it is still alive (this needs `heartbeat`).
   */
  wake: () => void;
}

/**
 * Connects the socket to its environment (browser events, React Native's `AppState`). It is called
 * once, on `connect()`, and returns a function that removes whatever it attached; that is called on
 * `close()`.
 */
export type Lifecycle = (controls: LifecycleControls) => () => void;

export interface SocketOptions<Incoming, Outgoing> {
  /** A string, or a sync or async function. A function is called again on every connect attempt. */
  url: string | (() => string | Promise<string>);
  protocols?: string | string[];
  /** Set to `false` to never reconnect. */
  reconnect?: ReconnectOptions | false;
  /**
   * If set, `send()` while not open queues up to this many messages and sends them in order once the
   * socket opens. Without it, `send()` while not open throws.
   */
  queueWhileOffline?: number;
  /**
   * Enables `socket.subscribe()`. Topics are reference-counted and sent again, in the order they were
   * first subscribed, after `onOpen` on every connection.
   */
  subscriptions?: SubscriptionOptions<Incoming, Outgoing>;
  /** Ping the server so a socket that is open but silent is detected and replaced. Off by default. */
  heartbeat?: HeartbeatOptions<Incoming, Outgoing>;
  /**
   * Runs once per connection, as soon as the WebSocket opens. Messages sent through `send` go out
   * first, before anything queued with `queueWhileOffline`. The socket stays `connecting` until the
   * returned promise resolves. If it rejects, the connection is dropped and retried.
   */
  onOpen?: (send: (message: Outgoing) => void) => void | Promise<void>;
  /** Close events for which `true` is returned stop reconnecting: the socket goes to `closed`. */
  isAuthFailure?: (event: CloseInfo) => boolean;
  /** `browserLifecycle()` on the web, `appStateLifecycle(AppState)` in React Native. */
  lifecycle?: Lifecycle;
  serialize?: (message: Outgoing) => string;
  parse?: (data: unknown) => Incoming;
  /** The `WebSocket` constructor to use. Defaults to the global one. */
  WebSocket?: WebSocketConstructor;
}

export interface Socket<Incoming, Outgoing> {
  readonly state: ConnectionState;
  /** Set once the socket is `closed`. */
  readonly closeReason: CloseReason | undefined;
  /** Starts connecting. Does nothing unless the state is `idle`. */
  connect(): void;
  /** Stops for good from any state: cancels pending timers and never reconnects. */
  close(code?: number, reason?: string): void;
  send(message: Outgoing): void;
  onState(listener: (state: ConnectionState) => void): () => void;
  onMessage(listener: (message: Incoming) => void): () => void;
  /**
   * Listens to one topic. The first listener for a topic sends the `subscribe` message (or, if the
   * socket is not open, it goes out when the socket opens); the last one to leave sends `unsubscribe`.
   * Returns a function that removes this listener, and is safe to call more than once. Requires the
   * `subscriptions` option.
   */
  subscribe(topic: string, handler: (message: Incoming) => void): () => void;
}
