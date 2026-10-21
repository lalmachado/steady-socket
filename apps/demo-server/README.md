# Demo server

A small WebSocket server that behaves like a real one and misbehaves on request. It exists to show
what `steady-socket` does when a connection goes wrong, and to test it against something that is
not a fake. It is a demo: there is no real security, so by default it only listens on `127.0.0.1`.

```bash
pnpm --filter @steady-socket/demo-server start
# steady-socket demo server on ws://127.0.0.1:8787
```

`PORT` and `HOST` change where it listens. To reach it from a phone on the same network, use
`HOST=0.0.0.0` and the computer's LAN address (and only on a network you trust).

## Protocol

JSON messages, the same ones the main README's examples use:

| Direction        | Message                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| client to server | `{ "type": "auth", "token": "…" }`                                     |
| client to server | `{ "type": "subscribe", "topic": "bed:42" }`                           |
| client to server | `{ "type": "unsubscribe", "topic": "bed:42" }`                         |
| client to server | `{ "type": "ping" }`                                                   |
| server to client | `{ "type": "pong" }`                                                   |
| server to client | `{ "type": "event", "topic": "bed:42", "payload": { "position": 7 } }` |

A connection has to authenticate before it subscribes, either with `?token=` in the URL or with an
`auth` message. Subscribing first closes the connection with code **4401**, which is what makes the
order of auth and replay visible. Get a token from `GET /token`; it lives for 60 seconds, and a
connection is closed with 4401 when its token runs out. Every subscribed topic gets an event once a
second.

## Making it misbehave

Plain HTTP on the same port (CORS is open, so a web page can call these):

```bash
curl http://127.0.0.1:8787/state                                # who is connected, to what
curl -X POST http://127.0.0.1:8787/control/silent               # stay connected, answer nothing
curl -X POST "http://127.0.0.1:8787/control/silent?on=false"    # answer again
curl -X POST "http://127.0.0.1:8787/control/restart?downMs=5000" # drop everyone, refuse new connections for 5 s
curl -X POST http://127.0.0.1:8787/control/expire-token         # close everyone with 4401
```

| Control        | What it simulates                                 | What `steady-socket` should do                                                                   |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `silent`       | A dead connection: open, but nothing arrives.     | The heartbeat gets no pong, drops the socket and reconnects. No `close` event ever fires.        |
| `restart`      | A server restart or deploy.                       | Retries with backoff and jitter while connections are refused, then recovers and replays topics. |
| `expire-token` | A session that ended: tokens are no longer valid. | `isAuthFailure` matches 4401, so the socket goes to `closed` with `auth-failure` and stops.      |

## Tests

```bash
pnpm --filter @steady-socket/demo-server test
```

The server's own behaviour is tested with a plain `ws` client. A second test file runs the real
`steady-socket` (from source) against it: connect and subscribe, replace a silent connection,
survive a restart, and stop on an expired token. It also checks that `ws` can be passed as the
`WebSocket` option in TypeScript, as the main README says to do in Node.
