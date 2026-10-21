import { browserLifecycle, createSocket, type Socket } from 'steady-socket';

/** Where the demo server (apps/demo-server) is listening. */
export const SERVER = process.env['NEXT_PUBLIC_DEMO_SERVER'] ?? 'http://127.0.0.1:8787';
const WS_SERVER = SERVER.replace(/^http/, 'ws');

export type Incoming =
  { type: 'pong' } | { type: 'event'; topic: string; payload: { position: number } };

export type Outgoing =
  | { type: 'ping' }
  | { type: 'auth'; token: string }
  | { type: 'subscribe' | 'unsubscribe'; topic: string };

export type DemoSocket = Socket<Incoming, Outgoing>;

/** The close code the demo server uses for "your credentials are bad". */
const AUTH_FAILURE_CODE = 4401;

/**
 * The same setup the main README shows, pointed at the demo server. Short timings, so that what
 * happens is visible within seconds.
 */
export function createDemoSocket(): DemoSocket {
  return createSocket<Incoming, Outgoing>({
    // A fresh token on every connect attempt, including every reconnect.
    url: async () => {
      const response = await fetch(`${SERVER}/token`);
      const { token } = (await response.json()) as { token: string };
      return `${WS_SERVER}/?token=${token}`;
    },
    heartbeat: {
      interval: 2000, // ping every 2 s
      timeout: 1000, // no pong within 1 s: the connection is dead
      ping: () => ({ type: 'ping' }),
      isPong: (message) => message.type === 'pong',
    },
    reconnect: { minDelay: 500, maxDelay: 5000, factor: 2, jitter: 'full' },
    subscriptions: {
      subscribe: (topic) => ({ type: 'subscribe', topic }),
      unsubscribe: (topic) => ({ type: 'unsubscribe', topic }),
      topicOf: (message) => (message.type === 'event' ? message.topic : undefined),
    },
    isAuthFailure: (event) => event.code === AUTH_FAILURE_CODE,
    // `offline` pauses reconnecting, `online` and a tab coming back to the foreground wake it.
    lifecycle: browserLifecycle(),
  });
}
