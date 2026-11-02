# How the comparison was made

The table in the [README](../README.md#how-it-compares) is read from each library's published code,
on **2 November 2026**, for these versions: `partysocket` 1.3.0, `reconnecting-websocket` 4.4.0,
`react-use-websocket` 4.13.0, `socket.io-client` 4.8.4 (with its `engine.io-client`). Packages were
downloaded with `npm pack` / `npm install --ignore-scripts` into scratch folders and only read, never
run. Where a cell says "no", the code was searched for the feature and none was found.

## Where each cell comes from

| Cell                                               | Where to look                                                                                                                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| partysocket: backoff, no jitter                    | `dist/ws.js`, `_getNextDelay()`: `min * factor ** (retry - 1)`, capped at `maxReconnectionDelay`; no random term                                                                                                                         |
| partysocket: async URL, queue                      | `UrlProvider` in the `.d.ts` (`() => Promise<string>`), `_connect()` asks for it every time; README: "Buffers messages when not connected"                                                                                               |
| partysocket / reconnecting-websocket: no heartbeat | no `ping`, `pong` or `heartbeat` in `dist/` or the README; no `online`, `visibilitychange` or `AppState` either                                                                                                                          |
| reconnecting-websocket: random first delay         | `dist/reconnecting-websocket-cjs.js`: `minReconnectionDelay: 1000 + Math.random() * 4000`, growth factor 1.3; last release 4.4.0, February 2020                                                                                          |
| react-use-websocket: heartbeat                     | `src/lib/heartbeat.ts`: pings every `interval`, closes the socket if nothing arrived within `timeout` (defaults 25 s and 60 s)                                                                                                           |
| react-use-websocket: reconnect                     | `src/lib/attach-listener.ts`: `shouldReconnect`, `reconnectAttempts` (20), `reconnectInterval` (5000 or a function of the attempt)                                                                                                       |
| react-use-websocket: fresh URL, queue              | `src/lib/use-websocket.ts`: `startRef.current` runs `getUrl` again on every reconnect; `messageQueue` keeps sends made while offline                                                                                                     |
| Socket.IO: jitter, `auth`                          | `socket.io-client/build/esm/manager.js` (`randomizationFactor` 0.5), `socket.js` (`auth` may be a function, called on each connect)                                                                                                      |
| Socket.IO: heartbeat, `offline`                    | `engine.io-client/build/esm/socket.js`: `pingInterval` and `pingTimeout` come from the server; an `offline` listener closes the transport; no `online`, visibility or app-state handling                                                 |
| Socket.IO: denied login, recovery, buffer          | `socket.js`: a `CONNECT_ERROR` packet destroys the socket; `recovered` / `_pid` / `_lastOffset` are the opt-in connection state recovery; `sendBuffer` holds emits while disconnected                                                    |
| Socket.IO needs its own server                     | `manager.js` connects to the path `/socket.io`, and `engine.io-client/build/esm/socket.js` adds the Engine.IO protocol version to the URL and speaks its handshake and packet format, which a plain WebSocket server does not understand |

## Sizes

Each library's main entry, bundled with esbuild, minified, then gzipped, with React (and React DOM)
external, the same command for every library:

```bash
esbuild entry.mjs --bundle --minify --format=esm --external:react --external:react-dom \
  --platform=browser --outfile=out.js && gzip -9 -c out.js | wc -c
```

The entry is the class or hook you would use: `partysocket/ws`, `reconnecting-websocket`,
`react-use-websocket`, `io` from `socket.io-client`, and for `steady-socket` `createSocket` (and the
three React hooks for the "+ React" figure). The result is what you ship, not how much each library
does: Socket.IO is larger because it also carries a protocol, acknowledgements and fallback
transports.

## If something here is wrong

These libraries change. If a cell is out of date or wrong, please open an issue with the version and
the place in the code, and it will be fixed.
