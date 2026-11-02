/**
 * The same behaviour as examples/hand-written.ts, with the library. Tested against the demo server
 * with the same scenarios (apps/demo-server/test/steady-socket.test.ts).
 */
import { browserLifecycle, createSocket } from 'steady-socket';

type Incoming = { type: 'pong' } | { type: 'event'; topic: string; payload: unknown };
type Outgoing = { type: 'ping' } | { type: 'subscribe' | 'unsubscribe'; topic: string };

export function createLibrarySocket(options: { url: string; getToken: () => Promise<string> }) {
  return createSocket<Incoming, Outgoing>({
    url: async () => `${options.url}/?token=${await options.getToken()}`,
    heartbeat: {
      interval: 15_000,
      timeout: 5_000,
      ping: () => ({ type: 'ping' }),
      isPong: (message) => message.type === 'pong',
    },
    reconnect: { minDelay: 500, maxDelay: 30_000, factor: 2, jitter: 'full' },
    subscriptions: {
      subscribe: (topic) => ({ type: 'subscribe', topic }),
      unsubscribe: (topic) => ({ type: 'unsubscribe', topic }),
      topicOf: (message) => (message.type === 'event' ? message.topic : undefined),
    },
    isAuthFailure: (event) => event.code === 4401,
    lifecycle: browserLifecycle(),
  });
}
