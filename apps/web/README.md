# Web demo

A Next.js (App Router) page that uses `steady-socket` the way the main README describes, against
the [demo server](../demo-server/README.md). Break the connection from the page and watch it recover.

![The web demo: a silent connection is detected, replaced and subscribed again](../../docs/web-demo.gif)

```bash
pnpm install
pnpm build                                         # the app runs the built package
pnpm --filter @steady-socket/demo-server start     # terminal 1: ws://127.0.0.1:8787
pnpm --filter @steady-socket/demo-web dev          # terminal 2: http://localhost:3000
```

`NEXT_PUBLIC_DEMO_SERVER` points the page at another server (it is read when the app is built).

Every page load makes up its own **session** and sends it with each call to the demo server
(`api()` in `app/socket.ts`). Against a [public server](../demo-server/README.md#running-it-for-other-people-public-mode)
that is what keeps your "restart" and "go silent" from reaching other visitors. Locally it changes
nothing you would notice.

## What the page shows

- **Connection**: the state from `useSocketState()`, and why a socket ended up `closed`.
- **Bed 42 position**: events from `useSubscription()`. The topic is subscribed again by the
  library after every reconnect, and the page does nothing about it.
- **Break it**: the demo server's controls. _Go silent_ is a connection that stays open but
  delivers nothing, which only the heartbeat can catch. _Restart server_ refuses connections for 5
  seconds. _Expire tokens_ ends in `closed` (`auth-failure`) and does not retry; _Sign in again_
  starts a new socket.
- **State changes** and **What the server sees**: what the client believes next to what the server
  knows, so you can check one against the other.

## Using it in Next.js: create the socket in an effect

`app/demo.tsx` creates the socket, connects it and closes it in one `useEffect`, and renders the
`SocketProvider` once the socket exists. Two reasons:

- **Not at module level.** A client component also renders on the server, where there is no
  connection to make (and on Node 20 no global `WebSocket`, so `createSocket` throws).
- **Not "create once, connect and close in an effect".** React Strict Mode runs an effect, cleans it
  up and runs it again in development. `close()` is final, so a socket closed by the first cleanup
  would stay closed. Creating it inside the effect gives the second run a fresh one.

`app/page.tsx` is a server component and renders on the server; the socket only exists in the browser.

## End-to-end check

```bash
pnpm --filter @steady-socket/demo-web e2e
```

Builds the app, starts the demo server and the production server, and drives the page in a real
browser: connect and subscribe, a silent connection, a server restart, expired tokens and signing in
again, going offline and back online, and no errors in the console. It then runs the app under
`next dev` and checks that React Strict Mode leaves exactly one socket and one listener. It needs a
Chromium: set `CHROMIUM_PATH`, or install Playwright's once with
`pnpm --filter @steady-socket/demo-web exec playwright-core install chromium`. It is not part of CI,
which has no browser; CI builds the app against the built package instead.

## Making the GIF

```bash
RECORD_DIR=/tmp/frames pnpm --filter @steady-socket/demo-web e2e     # paced run, saves screenshots
pnpm --filter @steady-socket/demo-web exec tsx e2e/make-gif.ts /tmp/frames docs/web-demo.gif 6.5
```

The second command needs `ffmpeg`. The last argument trims the final seconds of the run (the
offline check, where nothing changes on screen).
