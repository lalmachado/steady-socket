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

| Direction        | Message                                                               |
| ---------------- | --------------------------------------------------------------------- |
| client to server | `{ "type": "auth", "token": "…" }`                                    |
| client to server | `{ "type": "subscribe", "topic": "match:42" }`                        |
| client to server | `{ "type": "unsubscribe", "topic": "match:42" }`                      |
| client to server | `{ "type": "ping" }`                                                  |
| server to client | `{ "type": "pong" }`                                                  |
| server to client | `{ "type": "event", "topic": "match:42", "payload": { "score": 7 } }` |

A connection has to authenticate before it subscribes, either with `?token=` in the URL or with an
`auth` message. Subscribing first closes the connection with code **4401**, which is what makes the
order of auth and replay visible. Get a token from `GET /token`. A token is only for connecting: it is valid for 60 seconds, and a
connection that is already open does not depend on it. The server ends a connection with 4401 after
30 minutes, as a session that ran out would (`connectionTtlMs`), which also frees the room of tabs
nobody uses. Every subscribed topic gets an event once a second.

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
- **Limits** (all can be changed in `startDemoServer({ public: { … } })`; `MAX_CONNECTIONS` and
  `MAX_SESSIONS` set the first two from the environment): 500 connections in total, 4 per session,
  500 sessions at once, 120 tokens and 20 controls per session per minute, and a connection that
  does not authenticate within 10 s is closed. When the server is full, `GET /token` answers `503`
  with `{ "code": "full" }` (and `429` with `"rate-limited"`), so a client can tell "busy" from a
  failed login; the web demo shows a "busy" message and keeps retrying.

Limits that apply in every mode: messages over 4 KiB close the connection, a connection keeps at
most 20 topics of at most 64 characters, and a restart lasts at most 30 s.

What this does **not** do: stop a determined attacker. Someone can still fill the session
slots and lock out real visitors until they expire, and there is no per-IP limit (behind a proxy
every request has the proxy's address, so that needs the host's help). It is a demo: if it is
abused, redeploy it or take it down. Do not put anything real behind it.

### How many visitors it holds

Measured, not guessed: `pnpm --filter @steady-socket/demo-server load -- <url> <visitors> <seconds>`
opens that many visitors that behave like the web page (a session each, a connection, a ping every
2 s, `GET /state` every 2 s) and reports how late the pongs are. The demo's heartbeat gives a pong
1 s, so a later one is a connection that `steady-socket` would call dead. Run in the image with
**0.1 CPU and 512 MB**, which is what a free Render web service is described as having:

| visitors | CPU of the allowance | memory | pong p99 | pongs over 1 s | `/state` p99 |
| -------- | -------------------- | ------ | -------- | -------------- | ------------ |
| 300      | 52%                  | 29 MB  | 577 ms   | 0              | 420 ms       |
| 500      | 50%                  | 32 MB  | 594 ms   | 0              | 589 ms       |
| 700      | 68%                  | 31 MB  | 192 ms   | 0              | 3.4 s        |
| 1000     | 100%                 | 38 MB  | 449 ms   | 0              | 788 ms       |

500 connections is half the allowance, which leaves room for bursts, so that is the default cap.
At 1000 the allowance is all used: it still worked in these runs, with nothing in reserve. (The
slow `/state` at 700 is the first seconds, while everybody arrives at once.) Runs vary, so read
these as sizes, not promises. Two changes made the difference:

- Polling `/state` twice a second per page used up the whole allowance at about 300 visitors, since
  an HTTP request costs far more than a WebSocket message. The page now asks every 2 s, not at all
  while its tab is hidden, and once right after a button press.
- The server starts from one compiled file, not from TypeScript with `tsx`: about 2.4 s on that CPU
  instead of 6.8 s, which is the wait when the host wakes the server up, and about half the memory.

On a bigger plan, raise `MAX_CONNECTIONS` and `MAX_SESSIONS`. These are numbers for this demo on a
small CPU, not for `steady-socket`.

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
