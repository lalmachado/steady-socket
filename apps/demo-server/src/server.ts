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
}

export interface DemoServerState {
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
  state(): DemoServerState;
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

interface Client {
  socket: WebSocket;
  token: string | undefined;
  topics: Set<string>;
  expiryTimer: NodeJS.Timeout | undefined;
}

/**
 * A WebSocket server that behaves like the real thing and misbehaves on request.
 *
 * Protocol (JSON messages):
 *  - client → server: `{type:'auth', token}`, `{type:'subscribe', topic}`, `{type:'unsubscribe', topic}`,
 *    `{type:'ping'}`
 *  - server → client: `{type:'pong'}` and `{type:'event', topic, payload:{position}}`
 *
 * A connection must authenticate before it subscribes, with `?token=` in the URL or an `auth`
 * message. Anything else closes it with 4401.
 *
 * Control endpoints (HTTP, same port):
 *  - `GET  /token`                    issue a token
 *  - `GET  /state`                    what the server is doing now
 *  - `POST /control/silent?on=true`   stop answering pings and sending events, keep sockets open
 *  - `POST /control/restart?downMs=3` drop every connection and refuse new ones for a while
 *  - `POST /control/expire-token`     invalidate every token and close connections with 4401
 */
export async function startDemoServer(options: DemoServerOptions = {}): Promise<DemoServer> {
  const tokenTtlMs = options.tokenTtlMs ?? 60_000;
  const tickMs = options.tickMs ?? 1000;

  const tokens = new Map<string, number>(); // token → expiry time (ms since epoch)
  const clients = new Set<Client>();
  let issued = 0;
  let silent = false;
  let down = false;
  let restartTimer: NodeJS.Timeout | undefined;
  let position = 0;

  const isValid = (token: string | undefined): token is string => {
    if (token === undefined) return false;
    const expiresAt = tokens.get(token);
    return expiresAt !== undefined && expiresAt > Date.now();
  };

  const send = (client: Client, message: unknown): void => {
    client.socket.send(JSON.stringify(message));
  };

  const reject = (client: Client, reason: string): void => {
    client.socket.close(AUTH_FAILURE_CODE, reason);
  };

  const authenticate = (client: Client, token: string | undefined): void => {
    if (!isValid(token)) {
      reject(client, 'invalid or expired token');
      return;
    }
    client.token = token;
    clearTimeout(client.expiryTimer);
    // A token that runs out mid-connection ends the connection, like a real session would.
    const remaining = (tokens.get(token) ?? 0) - Date.now();
    client.expiryTimer = setTimeout(() => {
      reject(client, 'token expired');
    }, remaining);
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
      if (!silent) send(client, { type: 'pong' });
      return;
    }
    if (message.type === 'subscribe' || message.type === 'unsubscribe') {
      if (client.token === undefined) {
        reject(client, 'authenticate first');
        return;
      }
      if (typeof message.topic !== 'string') return;
      if (message.type === 'subscribe') client.topics.add(message.topic);
      else client.topics.delete(message.topic);
    }
  };

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const client: Client = { socket, token: undefined, topics: new Set(), expiryTimer: undefined };
    clients.add(client);
    socket.on('message', (raw) => {
      handleMessage(client, raw);
    });
    socket.on('close', () => {
      clearTimeout(client.expiryTimer);
      clients.delete(client);
    });
    // A token in the URL authenticates the connection straight away.
    const url = new URL(request.url ?? '/', 'http://localhost');
    const urlToken = url.searchParams.get('token');
    if (urlToken !== null) authenticate(client, urlToken);
  });

  const ticker = setInterval(() => {
    if (silent) return;
    position++;
    for (const client of clients) {
      for (const topic of client.topics) {
        send(client, { type: 'event', topic, payload: { position } });
      }
    }
  }, tickMs);

  const respond = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {
      'content-type': 'application/json',
      // The web demo calls these from another origin. This is a demo server, not a real one.
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    res.end(JSON.stringify(body));
  };

  const state = (): DemoServerState => {
    const topics: Record<string, number> = {};
    for (const client of clients) {
      for (const topic of client.topics) topics[topic] = (topics[topic] ?? 0) + 1;
    }
    return { connections: clients.size, silent, down, topics };
  };

  const dropAll = (code: number, reason: string): void => {
    for (const client of clients) client.socket.close(code, reason);
  };

  const handleHttp = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') {
      respond(res, 204, null);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/token') {
      const token = `token-${String(++issued)}`;
      tokens.set(token, Date.now() + tokenTtlMs);
      respond(res, 200, { token, expiresInMs: tokenTtlMs });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      respond(res, 200, state());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/control/silent') {
      silent = url.searchParams.get('on') !== 'false';
      respond(res, 200, state());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/control/restart') {
      const downMs = Number(url.searchParams.get('downMs') ?? 3000);
      down = true;
      // 1012 is "service restart": what a server sends when it shuts down on purpose.
      dropAll(1012, 'restarting');
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        down = false;
      }, downMs);
      respond(res, 200, state());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/control/expire-token') {
      tokens.clear();
      dropAll(AUTH_FAILURE_CODE, 'token expired');
      respond(res, 200, state());
      return;
    }
    respond(res, 404, { error: 'not found' });
  };

  const server: Server = createServer(handleHttp);
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (down) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
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
      clearTimeout(restartTimer);
      for (const client of clients) {
        clearTimeout(client.expiryTimer);
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
