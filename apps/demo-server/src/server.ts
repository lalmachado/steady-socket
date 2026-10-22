import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

export interface DemoServerOptions {
  /** 0 picks a free port. Default 8787. */
  port?: number;
  /** Default `127.0.0.1`: the demo has no real security, so it only listens locally unless told to. */
  host?: string;
  /** How long a token lives, in ms. Default 60 000. */
  tokenTtlMs?: number;
  /** How often subscribed topics get an event, in ms. Default 1000. */
  tickMs?: number;
  /** How often expired tokens and idle sessions are removed, in ms. Default 10 000. */
  sweepMs?: number;
  /**
   * Public mode, for a server anyone on the internet can reach. Without it, the server is the
   * open, shared playground it was built as: every client is in one session, and CORS allows any
   * origin. With it:
   *  - every request names its own `session`, and the controls only affect that session;
   *  - browsers may only call it from `allowedOrigins`;
   *  - connections, sessions and request rates are capped.
   */
  public?: PublicOptions;
}

export interface PublicOptions {
  /** Origins (such as `https://demo.example.com`) whose pages may use the server. */
  allowedOrigins: string[];
  /** Open connections in total. Default 200. */
  maxConnections?: number;
  /** Open connections for one session. Default 4. */
  maxConnectionsPerSession?: number;
  /** Sessions alive at once. Default 100. */
  maxSessions?: number;
  /** `GET /token` calls per session per minute. Default 120. */
  tokensPerMinute?: number;
  /** `POST /control/*` calls per session per minute. Default 20. */
  controlsPerMinute?: number;
  /** A connection that has not authenticated this long after opening is closed. Default 10 000. */
  authTimeoutMs?: number;
}

export interface DemoServerState {
  /** Open connections. */
  connections: number;
  /** The server answers nothing, but keeps connections open. */
  silent: boolean;
  /** WebSocket upgrades are refused, as if the server were restarting. */
  down: boolean;
  /** How many connections listen to each topic. */
  topics: Record<string, number>;
}

export interface DemoServer {
  readonly port: number;
  /** One session's state, or, without an argument, all sessions added together. */
  state(session?: string): DemoServerState;
  /** Stops listening and drops every connection. */
  close(): Promise<void>;
}

/** Close code for "your credentials are bad". `isAuthFailure` on the client matches it. */
export const AUTH_FAILURE_CODE = 4401;

/** `ws` hands over a Buffer, an ArrayBuffer or a list of Buffers, depending on `binaryType`. */
export const rawToString = (raw: RawData): string => {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
};

/** Limits that always apply, so one client cannot make the server hold unbounded data. */
const MAX_MESSAGE_BYTES = 4096;
const MAX_TOPICS_PER_CLIENT = 20;
const MAX_TOPIC_LENGTH = 64;
const MAX_RESTART_MS = 30_000;

/** The session of requests that do not name one (only allowed outside public mode). */
const DEFAULT_SESSION = 'default';
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

interface Client {
  socket: WebSocket;
  token: string | undefined;
  /** Known once the client has authenticated: the session its token was issued to. */
  session: string | undefined;
  topics: Set<string>;
  expiryTimer: NodeJS.Timeout | undefined;
  authTimer: NodeJS.Timeout | undefined;
}

/** What the controls change. Each visitor of a public server gets their own. */
interface Session {
  /** The server answers nothing, but keeps this session's connections open. */
  silent: boolean;
  /** This session's WebSocket upgrades are refused, as if the server were restarting. */
  down: boolean;
  restartTimer: NodeJS.Timeout | undefined;
  /** When this session last called each rate-limited endpoint (ms since epoch). */
  hits: Record<'token' | 'control', number[]>;
}

interface TokenRecord {
  expiresAt: number;
  session: string;
}

/**
 * A WebSocket server that behaves like the real thing and misbehaves on request.
 *
 * Protocol (JSON messages):
 *  - client → server: `{type:'auth', token}`, `{type:'subscribe', topic}`, `{type:'unsubscribe', topic}`,
 *    `{type:'ping'}`
 *  - server → client: `{type:'pong'}` and `{type:'event', topic, payload:{score}}`
 *
 * A connection must authenticate before it subscribes, with `?token=` in the URL or an `auth`
 * message. Anything else closes it with 4401.
 *
 * Control endpoints (HTTP, same port). Each takes an optional `?session=<id>`; a token belongs to
 * the session it was issued for, and the controls only affect one session. Without `session` the
 * request uses one shared session, which is what you want locally. Public mode requires it.
 *  - `GET  /token`                    issue a token
 *  - `GET  /state`                    what the server is doing now (all sessions, without `session`)
 *  - `POST /control/silent?on=true`   stop answering pings and sending events, keep sockets open
 *  - `POST /control/restart?downMs=3` drop every connection and refuse new ones for a while
 *  - `POST /control/expire-token`     invalidate every token and close connections with 4401
 */
export async function startDemoServer(options: DemoServerOptions = {}): Promise<DemoServer> {
  const tokenTtlMs = options.tokenTtlMs ?? 60_000;
  const tickMs = options.tickMs ?? 1000;

  const pub = options.public;
  const allowedOrigins = new Set(pub?.allowedOrigins);
  const limits = {
    connections: pub ? (pub.maxConnections ?? 200) : Infinity,
    connectionsPerSession: pub ? (pub.maxConnectionsPerSession ?? 4) : Infinity,
    sessions: pub ? (pub.maxSessions ?? 100) : Infinity,
    tokensPerMinute: pub ? (pub.tokensPerMinute ?? 120) : Infinity,
    controlsPerMinute: pub ? (pub.controlsPerMinute ?? 20) : Infinity,
    authTimeoutMs: pub ? (pub.authTimeoutMs ?? 10_000) : undefined,
  };

  const tokens = new Map<string, TokenRecord>();
  const sessions = new Map<string, Session>();
  const clients = new Set<Client>();
  let issued = 0;
  let score = 0;

  /** The session with this id, created if there is room. `undefined` means the server is full. */
  const sessionFor = (id: string): Session | undefined => {
    const existing = sessions.get(id);
    if (existing) return existing;
    if (sessions.size >= limits.sessions) return undefined;
    const created: Session = {
      silent: false,
      down: false,
      restartTimer: undefined,
      hits: { token: [], control: [] },
    };
    sessions.set(id, created);
    return created;
  };

  /** Counts a call against a per-minute limit. `false` means the session is over it. */
  const allow = (session: Session, bucket: 'token' | 'control', perMinute: number): boolean => {
    const now = Date.now();
    const recent = session.hits[bucket].filter((at) => now - at < 60_000);
    session.hits[bucket] = recent;
    if (recent.length >= perMinute) return false;
    recent.push(now);
    return true;
  };

  /** A client that has not authenticated yet counts as the default session. */
  const sessionOf = (client: Client): string => client.session ?? DEFAULT_SESSION;
  const isSilent = (client: Client): boolean => sessions.get(sessionOf(client))?.silent ?? false;

  const isValid = (token: string | undefined): token is string => {
    if (token === undefined) return false;
    const record = tokens.get(token);
    return record !== undefined && record.expiresAt > Date.now();
  };

  const send = (client: Client, message: unknown): void => {
    client.socket.send(JSON.stringify(message));
  };

  const reject = (client: Client, reason: string): void => {
    client.socket.close(AUTH_FAILURE_CODE, reason);
  };

  const authenticate = (client: Client, token: string | undefined): void => {
    const record = isValid(token) ? tokens.get(token) : undefined;
    if (token === undefined || record === undefined) {
      reject(client, 'invalid or expired token');
      return;
    }
    let sessionConnections = 0;
    for (const other of clients) {
      if (other !== client && other.session === record.session) sessionConnections++;
    }
    if (sessionConnections >= limits.connectionsPerSession) {
      // 1013: "try again later". It is not an auth failure, so a client would keep retrying.
      client.socket.close(1013, 'too many connections');
      return;
    }
    client.token = token;
    client.session = record.session;
    clearTimeout(client.authTimer);
    clearTimeout(client.expiryTimer);
    // A token that runs out mid-connection ends the connection, like a real session would.
    client.expiryTimer = setTimeout(() => {
      reject(client, 'token expired');
    }, record.expiresAt - Date.now());
  };

  const handleMessage = (client: Client, raw: RawData): void => {
    let message: { type?: unknown; token?: unknown; topic?: unknown };
    try {
      message = JSON.parse(rawToString(raw)) as typeof message;
    } catch {
      return; // not JSON: ignore it, like most servers would
    }
    if (message.type === 'auth') {
      authenticate(client, typeof message.token === 'string' ? message.token : undefined);
      return;
    }
    if (message.type === 'ping') {
      if (!isSilent(client)) send(client, { type: 'pong' });
      return;
    }
    if (message.type === 'subscribe' || message.type === 'unsubscribe') {
      if (client.token === undefined) {
        reject(client, 'authenticate first');
        return;
      }
      if (typeof message.topic !== 'string' || message.topic.length > MAX_TOPIC_LENGTH) return;
      if (message.type === 'unsubscribe') client.topics.delete(message.topic);
      else if (client.topics.size < MAX_TOPICS_PER_CLIENT) client.topics.add(message.topic);
    }
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const client: Client = {
      socket,
      token: undefined,
      session: undefined,
      topics: new Set(),
      expiryTimer: undefined,
      authTimer: undefined,
    };
    clients.add(client);
    socket.on('message', (raw) => {
      handleMessage(client, raw);
    });
    // `ws` emits an error before it closes a connection that broke the rules (a message over
    // `maxPayload`, for example). Without a listener, Node would crash the whole server for it.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(client.expiryTimer);
      clearTimeout(client.authTimer);
      clients.delete(client);
    });
    // A token in the URL authenticates the connection straight away.
    const url = new URL(request.url ?? '/', 'http://localhost');
    const urlToken = url.searchParams.get('token');
    if (urlToken !== null) authenticate(client, urlToken);
    if (limits.authTimeoutMs !== undefined && client.token === undefined) {
      client.authTimer = setTimeout(() => {
        reject(client, 'authenticate first');
      }, limits.authTimeoutMs);
    }
  });

  const ticker = setInterval(() => {
    score++;
    for (const client of clients) {
      if (isSilent(client)) continue;
      for (const topic of client.topics) {
        send(client, { type: 'event', topic, payload: { score } });
      }
    }
  }, tickMs);

  // Expired tokens and sessions nobody uses any more would otherwise pile up for ever.
  const sweeper = setInterval(() => {
    const now = Date.now();
    const live = new Set<string>();
    for (const [token, record] of tokens) {
      if (record.expiresAt <= now) tokens.delete(token);
      else live.add(record.session);
    }
    for (const client of clients) if (client.session !== undefined) live.add(client.session);
    for (const [id, session] of sessions) {
      if (id !== DEFAULT_SESSION && !live.has(id) && !session.down) sessions.delete(id);
    }
  }, options.sweepMs ?? 10_000);

  /** Browsers say where a page comes from; scripts and native apps do not. */
  const originOf = (req: IncomingMessage): string | undefined => req.headers.origin;
  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = originOf(req);
    return !pub || origin === undefined || allowedOrigins.has(origin);
  };

  const respond = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown) => {
    const origin = originOf(req);
    res.writeHead(status, {
      'content-type': 'application/json',
      // The web demo calls these from another origin. Public mode only answers the allowed ones.
      ...(pub
        ? origin !== undefined && allowedOrigins.has(origin)
          ? { 'access-control-allow-origin': origin, vary: 'origin' }
          : { vary: 'origin' }
        : { 'access-control-allow-origin': '*' }),
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    res.end(JSON.stringify(body));
  };

  const state = (id?: string): DemoServerState => {
    const topics: Record<string, number> = {};
    let connections = 0;
    for (const client of clients) {
      if (id !== undefined && sessionOf(client) !== id) continue;
      connections++;
      for (const topic of client.topics) topics[topic] = (topics[topic] ?? 0) + 1;
    }
    if (id !== undefined) {
      const session = sessions.get(id);
      return {
        connections,
        silent: session?.silent ?? false,
        down: session?.down ?? false,
        topics,
      };
    }
    const all = [...sessions.values()];
    return {
      connections,
      silent: all.some((session) => session.silent),
      down: all.some((session) => session.down),
      topics,
    };
  };

  const dropSession = (id: string, code: number, reason: string): void => {
    for (const client of clients) if (sessionOf(client) === id) client.socket.close(code, reason);
  };

  const handleHttp = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!originAllowed(req)) {
      respond(req, res, 403, { error: 'origin not allowed' });
      return;
    }
    if (req.method === 'OPTIONS') {
      respond(req, res, 204, null);
      return;
    }

    // Which session is this request for? Public mode makes the caller say.
    const named = url.searchParams.get('session');
    if (named !== null && !SESSION_ID.test(named)) {
      respond(req, res, 400, { error: 'session must be 8-64 letters, digits, - or _' });
      return;
    }
    if (named === null && pub && url.pathname !== '/state') {
      respond(req, res, 400, { error: 'session is required' });
      return;
    }
    const id = named ?? DEFAULT_SESSION;

    if (req.method === 'GET' && url.pathname === '/state') {
      respond(req, res, 200, state(named ?? undefined));
      return;
    }

    const isToken = req.method === 'GET' && url.pathname === '/token';
    const control =
      req.method === 'POST'
        ? /^\/control\/(silent|restart|expire-token)$/.exec(url.pathname)?.[1]
        : undefined;
    if (!isToken && control === undefined) {
      respond(req, res, 404, { error: 'not found' });
      return;
    }

    const session = sessionFor(id);
    if (!session) {
      respond(req, res, 503, { error: 'the demo is full, try again later' });
      return;
    }
    const bucket = isToken ? 'token' : 'control';
    if (!allow(session, bucket, isToken ? limits.tokensPerMinute : limits.controlsPerMinute)) {
      respond(req, res, 429, { error: 'too many requests' });
      return;
    }

    if (isToken) {
      const token = `token-${String(++issued)}`;
      tokens.set(token, { expiresAt: Date.now() + tokenTtlMs, session: id });
      respond(req, res, 200, { token, expiresInMs: tokenTtlMs });
      return;
    }
    if (control === 'silent') {
      session.silent = url.searchParams.get('on') !== 'false';
    } else if (control === 'restart') {
      const asked = Number(url.searchParams.get('downMs') ?? 3000);
      const downMs = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), MAX_RESTART_MS) : 3000;
      session.down = true;
      // 1012 is "service restart": what a server sends when it shuts down on purpose.
      dropSession(id, 1012, 'restarting');
      clearTimeout(session.restartTimer);
      session.restartTimer = setTimeout(() => {
        session.down = false;
      }, downMs);
    } else {
      for (const [token, record] of tokens) if (record.session === id) tokens.delete(token);
      dropSession(id, AUTH_FAILURE_CODE, 'token expired');
    }
    respond(req, res, 200, state(id));
  };

  /** Which session an upgrade is for, if its URL carries a token. */
  const sessionOfUpgrade = (req: IncomingMessage): string => {
    const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    return (token === null ? undefined : tokens.get(token)?.session) ?? DEFAULT_SESSION;
  };

  const refuse = (socket: Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  const server: Server = createServer(handleHttp);
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refusal = !originAllowed(req)
      ? '403 Forbidden'
      : clients.size >= limits.connections || sessions.get(sessionOfUpgrade(req))?.down
        ? '503 Service Unavailable'
        : undefined;
    if (refusal !== undefined) {
      refuse(socket, refusal);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8787, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Server has no TCP address.');

  return {
    port: address.port,
    state,
    close: async () => {
      clearInterval(ticker);
      clearInterval(sweeper);
      for (const session of sessions.values()) clearTimeout(session.restartTimer);
      for (const client of clients) {
        clearTimeout(client.expiryTimer);
        clearTimeout(client.authTimer);
        client.socket.terminate();
      }
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
