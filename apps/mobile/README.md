# Mobile demo

An [Expo](https://expo.dev) (React Native) app that uses `steady-socket` the way the main README
describes, against the [demo server](../demo-server/README.md). It is the same screen as the
[web demo](../web/README.md), with one difference: the lifecycle is React Native's `AppState`
through `appStateLifecycle(AppState)` instead of `browserLifecycle()`.

> **Status:** the app is type-checked, linted, and bundled by Metro in CI (Node 22). It has not
> been run on a device by CI, because CI has no device. Run it and check the scenarios below.

## Run it

Expo SDK 58 needs Node 22.13 or newer.

```bash
pnpm install
pnpm build                                  # the app runs the built package
HOST=0.0.0.0 pnpm --filter @steady-socket/demo-server start     # terminal 1
pnpm --filter @steady-socket/demo-mobile start                  # terminal 2, then scan the QR code
```

Open it in [Expo Go](https://expo.dev/go) on a phone, or press `i` / `a` for a simulator or
emulator.

A phone cannot reach `127.0.0.1` on your computer, so the demo server has to listen on the network
(`HOST=0.0.0.0`; only do this on a network you trust, the server has no real security). The app
finds the server by itself: it uses the address Expo is serving from, on port 8787. If that is
wrong (a tunnel, for example), set `EXPO_PUBLIC_DEMO_SERVER=http://<address>:8787` before
`pnpm start`.

## Things to try

- **Airplane mode.** Turn it on: the heartbeat gets no pong, the socket goes to `reconnecting`
  and keeps retrying with backoff. Turn it off: the next attempt connects and the topic is
  subscribed again, with no code in the app for that.
- **Background and back.** Send the app to the background for a while and return. When `AppState`
  reports `active` the log shows `app: active`, and the socket skips any backoff wait (or pings an
  open connection to check that it survived).
- **Break it** buttons: the same four as the web demo (go silent, restart, expire tokens, sign in
  again).

## How it is wired

- `src/socket.ts` is the whole `steady-socket` setup: heartbeat, backoff, a fresh token on every
  connect, subscriptions, `isAuthFailure`, and `lifecycle: appStateLifecycle(AppState)`.
- `src/App.tsx` creates the socket in an effect and renders `SocketProvider`, `useSocketState()`
  and `useSubscription()`, exactly like the web demo. See the [web demo's
  README](../web/README.md#using-it-in-nextjs-create-the-socket-in-an-effect) for why the socket
  is created in an effect.

## Two things about the setup

- **It runs the built package.** `tsconfig.json` maps `steady-socket` to the source so that
  lint and type-checking work without a build, and Expo's Metro bundler would follow those `paths`
  by default. `app.json` turns that off (`experiments.tsconfigPaths`), so the app bundles
  `dist` like any user's app. Bundling fails if `dist` is missing, which is how to check it.
- **No `react-native` import in the package.** `AppState` comes from the app and is passed in.

`pnpm --filter @steady-socket/demo-mobile bundle` runs the same Metro bundle CI does.
