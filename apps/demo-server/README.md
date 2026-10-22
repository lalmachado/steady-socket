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

## Sessions

Every HTTP call takes an optional `?session=<id>` (8 to 64 letters, digits, `-` or `_`). A token
belongs to the session it was issued for, and the controls below only affect that session: one
visitor's "go silent" or "restart" is not seen by another. Without `session`, everything shares one
session, which is what you want when you run it for yourself.

## Making it misbehave

Plain HTTP on the same port (CORS is open, so a web page can call these):

```bash
curl http://127.0.0.1:8787/state                                # who is connected, to what (add ?session=<id> for one)
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

## Running it for other people (public mode)

The server above trusts everyone who can reach it. To put it on the internet, set
`ALLOWED_ORIGINS` (comma separated, for example `https://steady-socket-demo.example.com`). That
turns on public mode:

- **A session is required** for `/token` and `/control/*`, so visitors cannot affect each other.
  The web demo makes up a random one per page load.
- **Origins are checked.** A browser page from any other origin gets `403`, for the WebSocket and
  for the controls (a control is refused, not just unreadable). Native apps and `curl` send no
  `Origin` header and are not blocked by this; the limits below are what bound them.
- **Limits** (all can be changed in `startDemoServer({ public: { … } })`): 200 connections in
  total, 4 per session, 100 sessions at once, 120 tokens and 20 controls per session per minute,
  and a connection that does not authenticate within 10 s is closed.

Limits that apply in every mode: messages over 4 KiB close the connection, a connection keeps at
most 20 topics of at most 64 characters, and a restart lasts at most 30 s.

What this does **not** do: stop a determined attacker. Someone can still fill the 100 session
slots and lock out real visitors until they expire, and there is no per-IP limit (behind a proxy
every request has the proxy's address, so that needs the host's help). It is a demo: if it is
abused, redeploy it or take it down. Do not put anything real behind it.

### Docker

`PORT` and `HOST` work as before (the image sets `HOST=0.0.0.0` and `PORT=8787`). Build from the
repository root:

```bash
docker build -f apps/demo-server/Dockerfile -t steady-socket-demo-server .
docker run --rm -p 8787:8787 -e ALLOWED_ORIGINS=https://your-demo-site.example steady-socket-demo-server
```

[DEPLOYING.md](../../DEPLOYING.md) has the steps for Render (`render.yaml` at the repository root) and
Vercel. Any host that runs a container works. The image sets `REQUIRE_ALLOWED_ORIGINS=1`, so it refuses to
start without `ALLOWED_ORIGINS` instead of running as an open playground. The host must serve it over HTTPS (so clients can use
`wss://`) and must allow long-lived WebSocket connections. Use `GET /state` as the health check.

## Tests

```bash
pnpm --filter @steady-socket/demo-server test
```

The server's own behaviour is tested with a plain `ws` client. A second test file runs the real
`steady-socket` (from source) against it: connect and subscribe, replace a silent connection,
survive a restart, and stop on an expired token. A third file covers sessions and public mode:
isolation between sessions, origins, every limit, and cleanup. It also checks that `ws` can be passed as the
`WebSocket` option in TypeScript, as the main README says to do in Node.
