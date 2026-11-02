# steady-socket

> A WebSocket client that stays connected — on the web and in React Native.

[![npm](https://img.shields.io/npm/v/steady-socket)](https://www.npmjs.com/package/steady-socket) [![CI](https://github.com/lalmachado/steady-socket/actions/workflows/ci.yml/badge.svg)](https://github.com/lalmachado/steady-socket/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-MIT-blue)

## What is this?

Many apps get live updates from a server: the score of a match, a chat message, a delivery moving on a map. They usually do it with a **WebSocket**, one connection that stays open so the server can send data whenever it wants.

That connection breaks more often than you would expect. The Wi-Fi drops, a phone locks its screen, the server restarts, a login expires, or a router quietly stops passing data and nothing tells the app. Left alone, the app shows stale data, reconnects so eagerly that it hammers the server, or forgets what it was listening to.

`steady-socket` is a small library that looks after that connection. You say what you want to hear about, for example `match:42`, and it keeps the connection healthy: it notices a dead connection (it pings the server), reconnects with growing delays, logs in again, and subscribes to everything again. Your code only sees the connection state (`open`, `reconnecting`, `closed`) and the messages. There is a [live demo](#demo) where you can break the connection yourself.

`steady-socket` wraps the platform `WebSocket` with the parts every real-time app ends up rewriting: heartbeats that catch dead connections, reconnects with backoff and jitter, fresh auth on every reconnect, subscriptions that come back by themselves, and awareness of when a mobile app goes to the background.

A thin React layer sits on top and runs unchanged in Next.js and Expo.

**At a glance**

- **About 1.6 kB** minified and gzipped for the core, plus 0.4 kB for the React hooks (CI fails if the core grows past 3 kB).
- **No dependencies** in the core. `react` is an optional peer dependency.
- **Strict TypeScript**, ESM and CJS, published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
- **Tested** with fake timers for every state transition, and against a real WebSocket server that goes silent, restarts and expires logins.
- **22 lines** of setup, against 141 for the same behaviour written by hand ([see below](#what-writing-it-by-hand-involves)).

> **Status:** early release (0.x). The API is complete for what is described below and is covered by tests, but it may still change in minor versions until 1.0. Changes are listed in [CHANGELOG.md](./CHANGELOG.md); the plan is in [ROADMAP.md](./ROADMAP.md).

---

## Why

A WebSocket that works in a demo and one that works in production are different things. Reconnecting clients such as `partysocket` and `reconnecting-websocket` already cover backoff and a fresh URL on each connect, and `react-use-websocket` and Socket.IO have heartbeats. What the plain-WebSocket libraries leave to you is the part that sits on top of the connection (see [how it compares](#how-it-compares)):

- **The server forgets your subscriptions.** A new connection starts empty. Whatever the client was listening to has to be sent again, after auth and in the right order. `steady-socket` reference-counts subscriptions per topic and replays them after your `onOpen` auth step on every reconnect.
- **Mobile apps go to sleep.** In the background, timers stop being reliable and the OS may drop the connection. When the app comes back, the user expects live data immediately, not after the next backoff step. `steady-socket` takes React Native's `AppState` (passed in by you) and skips the backoff wait on foreground.
- **Connections die without telling you.** A NAT timeout, a proxy, or a phone switching from Wi-Fi to 4G can leave a socket that looks open but delivers nothing. No `close` event ever fires. Only a heartbeat catches it, and `partysocket` and `reconnecting-websocket` have none.
- **Bad credentials should stop the loop.** A close code that means "your token is wrong" moves the socket to `closed` with a reason instead of retrying forever.

All of it sits behind a small, explicit state machine you can observe and test, with no dependencies in the core.

## How it compares

Read from each library's published code (versions below), not from memory or marketing.

|                                           | steady-socket                            | partysocket 1.3 | reconnecting-websocket 4.4 | react-use-websocket 4.13                   | Socket.IO client 4.8                               |
| ----------------------------------------- | ---------------------------------------- | --------------- | -------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Talks to a plain WebSocket server         | yes                                      | yes             | yes                        | yes                                        | **no**: needs a Socket.IO server                   |
| Reconnects with backoff                   | yes, full jitter                         | yes, no jitter  | yes, random first delay    | fixed 5 s, 20 tries; you write any backoff | yes, with jitter                                   |
| Heartbeat for silently dead connections   | yes                                      | no              | no                         | yes                                        | yes, driven by the server                          |
| Fresh URL or credentials on every connect | yes                                      | yes             | yes                        | yes                                        | yes (`auth` function)                              |
| Stops for good when credentials are bad   | yes (`isAuthFailure`)                    | by hand         | by hand                    | with `shouldReconnect`                     | yes, when the server denies the login              |
| Subscribes again after a reconnect        | yes, after auth                          | no              | no                         | no                                         | partly: opt-in recovery on the server, short drops |
| Reacts to the app or network waking up    | yes: web events, React Native `AppState` | no              | no                         | no                                         | partly: closes on the browser's `offline`          |
| Queues sends while offline                | opt-in                                   | yes             | yes                        | yes                                        | yes                                                |
| React hooks                               | yes                                      | yes             | no                         | yes (it is the library)                    | no                                                 |
| Size, minified and gzipped                | 1.6 kB (+0.4 kB React)                   | 2.7 kB          | 3.2 kB                     | 6.8 kB                                     | 13.0 kB                                            |
| Last release                              | Oct 2026, 0.x                            | Jun 2026        | Feb 2020                   | Feb 2025                                   | Sep 2026                                           |

**Where the others are better.**

- **Socket.IO** gives you rooms, acknowledgements (request and response), fallback transports and a large ecosystem. If you control the server and want those, use it. `steady-socket` is for plain WebSocket servers, and it has no acknowledgements yet.
- **partysocket** is established and actively released (1.3.0 in June 2026), is a drop-in `WebSocket` replacement, and lists support for Cloudflare Workers, Deno and Bun. If reconnecting and buffering is all you need, it is the simpler choice.
- **react-use-websocket** can share one socket between components (`share`), has JSON helpers, and can also speak Socket.IO and Server-Sent Events.
- **`steady-socket` is new** (0.x): it has few users so far, and its API may change before 1.0.

[How each cell was checked](./docs/comparison.md): versions as published on npm on the day of writing; features read from each package's source and types (`reconnecting-websocket` has had no release since 2020); sizes are the main entry bundled with esbuild, minified and gzipped with React external, the same way for every library. They compare what you ship, not how much each library does.

## What writing it by hand involves

None of this is magic, and you can write it yourself. [`examples/hand-written.ts`](./examples/hand-written.ts) is a careful version for a plain WebSocket: backoff with jitter, a fresh token on every connection, a heartbeat, subscriptions sent again after every reconnect, a stop on close code 4401, and a wake-up when the page comes back. It is **141 lines of code** and it passes the same four scenarios as the library against the demo server: a connection that goes silent, a server restart, an expired login, and subscriptions after a reconnect ([the tests](./apps/demo-server/test/hand-written.test.ts)).

[`examples/with-steady-socket.ts`](./examples/with-steady-socket.ts) is the same behaviour with the library, **22 lines**:

```ts
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
```

The line count is not the point. The details are: writing the hand-made version turned up each of these.

- **A dead socket may never say it is dead.** A connection that went quiet may not emit `close` for a long time, or ever, so the heartbeat has to give up on it without waiting for the event, and ignore it if it does arrive late.
- **A late `close` from an old socket must not start a second reconnect**, and closing while a token is still being fetched must not open a socket afterwards.
- **`ws` in Node throws if nobody listens for `error`.** The first draft of the hand-written file crashed the test process when the server refused a reconnect during a restart. Browsers do not do this, so it only shows up in Node.
- **Not covered by the hand-written version:** an observable state and close reason, `send` with an offline queue, React hooks, the React Native lifecycle, typed messages, and a test suite. The library has fake-timer tests of every transition, which is what keeps the cases above fixed.

## Install

```bash
npm install steady-socket
```

React and React Native support are included as subpath exports. `react` is an optional peer dependency, and `steady-socket` never imports `react-native` directly.

## Quick start

```ts
import { createSocket } from 'steady-socket';

type Incoming = { type: 'pong' } | { type: 'event'; topic: string; payload: { score: number } };

type Outgoing =
  | { type: 'ping' }
  | { type: 'auth'; token: string }
  | { type: 'subscribe' | 'unsubscribe'; topic: string };

const socket = createSocket<Incoming, Outgoing>({
  // Called on every connect, so each reconnect gets a fresh token.
  url: async () => `wss://api.example.com/ws?token=${await getToken()}`,

  heartbeat: {
    interval: 15_000, // send a ping every 15 s
    timeout: 5_000, // no pong within 5 s → treat the socket as dead
    ping: () => ({ type: 'ping' }),
    isPong: (msg) => msg.type === 'pong',
  },

  reconnect: {
    minDelay: 500,
    maxDelay: 30_000,
    factor: 2,
    jitter: 'full',
  },

  subscriptions: {
    subscribe: (topic) => ({ type: 'subscribe', topic }),
    unsubscribe: (topic) => ({ type: 'unsubscribe', topic }),
    topicOf: (msg) => (msg.type === 'event' ? msg.topic : undefined),
  },
});

socket.onState((state) => console.log(state));
// 'idle' → 'connecting' → 'open' → 'reconnecting' → 'open' … → 'closed'

const stop = socket.subscribe('match:42', (msg) => {
  if (msg.type === 'event') console.log(msg.payload);
});

socket.connect();

// later
stop();
socket.close();
```

## Auth on every connection

Protocols differ. Some take the token in the URL, which the async `url` option covers. Others expect an auth message first. `onOpen` runs after the socket opens and **before** anything else is sent, so the server always sees auth first. The socket stays `connecting` until the promise `onOpen` returns resolves; if it rejects, the connection is dropped and retried. Subscriptions are replayed right after it, and messages queued while offline go out after that:

```ts
createSocket({
  url: 'wss://api.example.com/ws',
  onOpen: async (send) => {
    send({ type: 'auth', token: await getToken() });
  },
  // Close codes that mean "your credentials are bad": don't keep retrying with them.
  isAuthFailure: (event) => event.code === 4401,
  // …
});
```

## Subscriptions

With the `subscriptions` option, `socket.subscribe(topic, handler)` listens to one topic and returns a function that stops listening.

- **Reference-counted.** Two listeners on `match:42` send one `subscribe` message. `unsubscribe` is sent when the last listener leaves. Calling a returned function twice is harmless.
- **Replayed on every connection.** The server forgets everything when a connection drops, so the topics are sent again, in the order they were first subscribed, after `onOpen` finishes. A topic that everyone left while the socket was offline is not replayed.
- **Routed by `topicOf`.** A message reaches the listeners of the topic `topicOf` returns for it. Messages with no topic only reach `onMessage`.
- **Order on each connection:** `onOpen` messages, then replayed subscriptions, then anything queued with `queueWhileOffline`. All of it is sent before the state becomes `open`, so a state listener can't jump ahead of it.
- After `close()`, topics are forgotten and `subscribe()` does nothing.

## React

```tsx
import { SocketProvider, useSocketState, useSubscription } from 'steady-socket/react';

type EventMessage = Extract<Incoming, { type: 'event' }>;

function App() {
  return (
    <SocketProvider socket={socket}>
      <MatchScore id="42" />
    </SocketProvider>
  );
}

function MatchScore({ id }: { id: string }) {
  const state = useSocketState(); // built on useSyncExternalStore
  const [score, setScore] = useState<number>();

  useSubscription<EventMessage>(`match:${id}`, (msg) => setScore(msg.payload.score));

  if (state !== 'open') return <p>Reconnecting…</p>;
  return <p>Score: {score}</p>;
}
```

- **`SocketProvider`** only provides the socket. You create it, call `connect()` and decide when to `close()` it.
- **`useSocketState()`** re-renders only when the connection state changes. During server rendering it returns `'idle'`.
- **`useSubscription(topic, handler)`** subscribes on mount and unsubscribes on unmount. It does not resubscribe when you pass a new handler on every render, and always calls the latest one. It resubscribes only if `topic` or the socket changes. It is safe under React Strict Mode: the mount/unmount/mount cycle leaves exactly one listener.
- **Types:** the provider erases the socket's message types, so `useSocket<Incoming, Outgoing>()` and `useSubscription<Incoming>()` take them as type arguments. Like `fetch<T>()`, that is your claim and is not checked at runtime.
- Needs React 18 or newer (it uses `useSyncExternalStore`).
- **Create the socket in an effect, not at module level.** `close()` is final, and React Strict Mode runs an effect, cleans it up and runs it again in development; a client component also renders on the server, where there is no connection to make. So create, `connect()` and `close()` the socket together inside one `useEffect`, and render the provider once it exists. The [web demo](./apps/web/app/demo.tsx) does exactly that.

## React Native and the browser

The `lifecycle` option connects the socket to its environment. An adapter is attached when you call `connect()` and removed on `close()`.

**React Native.** Pass `AppState` in; the package never imports `react-native`. When the app comes back to `active`, the socket does not wait for its next scheduled attempt: if it is reconnecting, it connects straight away; if it looks open, it pings straight away (needs `heartbeat`), so a connection the OS dropped in the background is replaced in seconds.

```ts
import { AppState } from 'react-native';
import { appStateLifecycle } from 'steady-socket/react-native';

const socket = createSocket({
  // …
  heartbeat: {/* … */},
  lifecycle: appStateLifecycle(AppState),
});
```

**Web.** `browserLifecycle()` listens to the browser:

- `offline` pauses reconnecting. The socket waits in `reconnecting` and does not use up attempts.
- `online` ends the pause and connects straight away (or pings, if the socket is open).
- A tab becoming visible again does the same: skip any backoff wait, or check that an open connection is still alive.

```ts
import { browserLifecycle, createSocket } from 'steady-socket';

const socket = createSocket({ /* … */ lifecycle: browserLifecycle() });
```

Pinging on wake only works if you configured `heartbeat`; without it, an open socket is left alone because there is nothing to ask it.

## Connection states

```
idle ──connect()──▶ connecting ──open──▶ open
                        ▲                  │
                        │            close / heartbeat timeout
                        │                  ▼
                        └──backoff──── reconnecting
                                           │
              close() from any state  ─────┴────▶ closed
```

`close()` is final: it works from any state, cancels pending timers, and the socket never reconnects. `connect()` only does something from `idle`. When a socket ends up `closed`, `socket.closeReason` says why (`'closed-by-user'`, `'connection-lost'` when reconnecting is off, `'max-attempts'`, or `'auth-failure'` when `isAuthFailure` returned true for the close event).

With `heartbeat` set, a pong that does not arrive within `timeout` closes the socket with code 4000 and goes to `reconnecting` straight away, without waiting for a `close` event that a dead connection may never send. Pongs are consumed by the heartbeat and are not passed to `onMessage` listeners.

`socket.state` always holds the current state, and `onState` notifies every transition. A connection that fails auth (`isAuthFailure`) goes to `closed` with a reason, rather than retrying forever.

## Options

| Option                | Default  | What it does                                                                                                                                                                                     |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`                 | —        | A string, or a sync or async function called on every connect.                                                                                                                                   |
| `protocols`           | —        | Passed through to `WebSocket`.                                                                                                                                                                   |
| `heartbeat`           | off      | `interval`, `timeout`, `ping()`, `isPong(msg)`.                                                                                                                                                  |
| `reconnect`           | on       | `minDelay` (500), `maxDelay` (30 000), `factor` (2), `jitter` (`'full'` or `'none'`, default `'full'`), `maxAttempts` (default: no limit), `random` (for tests). `false` turns reconnecting off. |
| `queueWhileOffline`   | off      | Max number of messages `send()` buffers while the socket is not open. Without it, `send()` throws when not open.                                                                                 |
| `subscriptions`       | off      | `subscribe(topic)`, `unsubscribe(topic)`, `topicOf(msg)`.                                                                                                                                        |
| `onOpen`              | —        | Async hook before subscriptions are replayed.                                                                                                                                                    |
| `isAuthFailure`       | —        | Close events that should stop reconnecting.                                                                                                                                                      |
| `lifecycle`           | —        | `browserLifecycle()` or `appStateLifecycle(AppState)`: pauses and wakes the socket from environment events.                                                                                      |
| `onError`             | rethrown | Called when a message cannot be parsed, or one of your handlers, listeners, `isPong` or `topicOf` throws. The socket carries on.                                                                 |
| `serialize` / `parse` | JSON     | Message encoding.                                                                                                                                                                                |
| `WebSocket`           | global   | The constructor to use. Pass `ws` in Node, or a fake in tests.                                                                                                                                   |

## When your code throws

A message that `parse` cannot read, or a handler, `onMessage` or `onState` listener, `isPong` or `topicOf` that throws, never breaks the connection: the other listeners still get the message, and so does the next one. Pass `onError` to see these errors:

```ts
createSocket({
  // …
  onError: (error) => reportToYourErrorTracker(error),
});
```

Without it, the error is rethrown from a timer, so it still shows up as an uncaught error (like a DOM event listener that throws) and is not swallowed. In Node with `ws`, that means the process sees it, so pass `onError` if a malformed message from a server should not be fatal.

## Testing your app

Because the `WebSocket` constructor can be injected, you can test code that uses `steady-socket` without a server. The package's own tests use a fake socket and fake timers to drive every transition, including heartbeats that never get a pong.

## Demo

**[Try the web demo](https://steady-socket.vercel.app)**: press the buttons that break the
connection and watch it recover. The server behind it runs on a free plan that sleeps when idle, so
the first visit can take up to a minute to connect; the page says so and `steady-socket` keeps
retrying until the server answers. Each visitor's buttons only affect their own connection.

`apps/demo-server` is a WebSocket server that can go silent while staying open, restart, and expire
tokens on request. `apps/web` is a Next.js page that uses `steady-socket` against it, so you can
break the connection and watch it recover. `apps/mobile` is the same screen as an Expo app, using
`appStateLifecycle(AppState)`; CI bundles it, but nothing runs it on a device yet. See the
[web demo](./apps/web/README.md), the [mobile demo](./apps/mobile/README.md) and the
[server](./apps/demo-server/README.md).

![The web demo: a silent connection is detected, replaced and subscribed again](./docs/web-demo.gif)

## Contributing

Issues and PRs are welcome. `pnpm test` runs the suite and `pnpm changeset` records a change for the next release. [RELEASING.md](./RELEASING.md) explains how releases are published.

## License

MIT © Luís Machado
