export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Why a socket ended up in `closed`. */
export type CloseReason = 'closed-by-user' | 'connection-lost' | 'max-attempts';

/** The subset of the `WebSocket` API this library relies on. Browsers, React Native and `ws` all fit. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
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
}
