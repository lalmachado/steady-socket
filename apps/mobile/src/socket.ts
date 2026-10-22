import Constants from 'expo-constants';
import { AppState } from 'react-native';
import { createSocket, type Socket } from 'steady-socket';
import { appStateLifecycle } from 'steady-socket/react-native';

/**
 * Where the demo server (apps/demo-server) is listening. A phone cannot use 127.0.0.1, so by
 * default this is the computer that serves the app: Expo knows its address (`hostUri`), and the
 * demo server is on the same computer, port 8787. `EXPO_PUBLIC_DEMO_SERVER` overrides it.
 */
// Expo types these as `any` (its config types are not part of this app's dependencies), so they
// are read as `unknown` and checked.
const hostUri: unknown = Constants.expoConfig?.hostUri;
const override: unknown = process.env.EXPO_PUBLIC_DEMO_SERVER;
const devHost = typeof hostUri === 'string' ? hostUri.split(':')[0] : undefined;
export const SERVER =
  typeof override === 'string' && override !== ''
    ? override
    : `http://${devHost ?? '127.0.0.1'}:8787`;
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
 * The same setup as the web demo (and the main README), with one difference: the lifecycle is
 * React Native's `AppState`, which you pass in. `steady-socket` never imports `react-native`.
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
    // Coming back to the foreground skips the backoff wait, or pings an open socket to check it.
    lifecycle: appStateLifecycle(AppState),
  });
}
