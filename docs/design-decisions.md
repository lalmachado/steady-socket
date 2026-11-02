# Design decisions

Why `steady-socket` works the way it does: what was chosen, what the alternative was, what it
costs, and where to look in the code. The last sections list the weaknesses and the questions a
reader is likely to ask. Everything here describes the code as it is; where something is a known
gap, it says so.

The core is `src/socket.ts` (a little over 300 lines). Read it with this page open.

## 1. An explicit state machine, and `closed` is final

**Chosen.** Five states: `idle → connecting → open → reconnecting → closed`. `connect()` only does
something from `idle`; `close()` ends the socket from any state and `closed` is terminal: timers
are cancelled, the offline queue and the subscribed topics are cleared, and the lifecycle adapter is
detached (`stop()`). A `closeReason` says why: `closed-by-user`, `connection-lost`, `max-attempts`
or `auth-failure`.

**Alternative.** A socket you can `close()` and `connect()` again.

**Why.** The states are the part of a connection that application code needs to see, and an
explicit, observable machine is the easiest thing to test: the transitions are tested with fake
timers. A terminal `closed` gives one clean invariant (after it, nothing is running and nothing will
run), and it removes a class of races (`close()` then `connect()` while an async step is in flight).

**Cost.** In React Strict Mode an effect runs, cleans up, and runs again, so a socket created
_outside_ the effect would be closed by the first cleanup and stay closed. The socket has to be
created, connected and closed inside one effect (see the web demo). That is real friction: see
"Known weaknesses".

## 2. Late async results are ignored with a generation counter

**Chosen.** Every connection attempt takes a number (`generation`). Anything that gives up on an
attempt (`abandon`, `stop`, a `close` event) bumps it, and every async step (`url()`, `onOpen`, the
socket's `open`, `message` and `close` events) compares the number it captured with the current one
before doing anything.

**Alternative.** Removing every listener and aborting every promise (`AbortController`) when an
attempt ends.

**Why.** A dead socket may never fire `close`, an `await url()` may finish after `close()`, and an
old socket's late `close` must not start a second reconnect. One integer check covers all of these
with no bookkeeping of listeners. The tests for "late events from an old socket" and "close while
the URL is still being fetched" exercise exactly this.

**Cost.** It is a convention: a new async step that forgets the check is a bug. The code comments
mark where it is used.

## 3. The heartbeat is application-level, and only a pong counts

**Chosen.** `heartbeat: { interval, timeout, ping, isPong }`. Every `interval` the socket sends your
`ping()` message; if no message for which `isPong` is true arrives within `timeout`, it gives up on
the connection (`abandon`) and reconnects. Pongs are consumed and not passed to listeners. A ping
that is still waiting for its pong is not stacked with another.

**Alternative.** WebSocket protocol ping frames, or treating any incoming message as proof of life.

**Why.** Browsers do not expose protocol ping and pong frames to JavaScript, so a client cannot send
or observe them: the only portable way to check liveness is an application message and a reply.
The operating system's TCP keepalive is no substitute: it is often set to two hours and the page
cannot change it. A connection that is open but delivers nothing (a NAT timeout, a proxy, a phone
switching networks) emits no `close` event, so nothing but a heartbeat notices it.

**Cost.** The server has to answer the ping. Requiring a pong, and not "any message", is stricter
than some libraries (`react-use-websocket` counts any inbound message): a busy connection that
never pongs is declared dead. The strictness is deliberate (a flood of events says nothing about
whether the _round trip_ works), but a server that cannot pong cannot use the heartbeat.

**A dead socket is abandoned, not closed politely.** `abandon()` does not wait for the `close` event
(it may never come): it bumps the generation, calls `close(4000, 'heartbeat timeout')` and schedules
a retry. 4000 and 4001 (`onOpen` failed) are in the range RFC 6455 reserves for private use
(4000 to 4999).

## 4. Full jitter

**Chosen.** The delay before retry _n_ is a random number between 0 and
`min(maxDelay, minDelay × factor^n)` (`'full'`), which is the default; `'none'` waits the ceiling.
`random` can be injected, so tests are deterministic.

**Alternative.** Plain exponential backoff, or "equal" or "decorrelated" jitter.

**Why.** After a server restart every client retries; without jitter they all retry at the same
instants and hit the server in synchronised waves. Randomising the whole interval spreads them out
(the AWS Architecture Blog post "Exponential Backoff And Jitter" compares the variants). Full jitter
is the simplest one with a good spread.

**Cost.** A retry can come almost immediately (the delay can be close to 0), and the median wait is
half the ceiling.

**A connection has to stay up before it counts as a success.** The delays only start over once a
connection has stayed open for `minUptime` (5000 ms by default); one that drops sooner counts as a
failed attempt, also towards `maxAttempts`. Resetting the moment a connection opens is the obvious
version, and it has a bad failure: against a server that accepts every connection and closes it at
once (a crash loop, an overloaded proxy), a client with default settings reconnected 18 to 20 times
in 5 seconds, for ever. With `minUptime` the same test makes 5 connections in 5 seconds and the
delay keeps growing. `partysocket` has the same option. `minUptime: 0` gives the old behaviour.

**Waking skips the wait.** `wake()` (the page became visible, the network is back, a React Native
app became active) connects now if the socket is `reconnecting`, and pings now if it is `open`. It
does not reset the attempt counter, so a wake-up that fails keeps climbing the ladder.

## 5. Credentials are fetched on every connection, and bad ones stop the loop

**Chosen.** `url` can be an async function called on every attempt (a fresh token each time), and
`onOpen` runs after the socket opens and before anything else is sent: the socket stays `connecting`
until it resolves, and if it rejects the connection is abandoned and retried. `isAuthFailure(event)`
decides which close events mean "your credentials are bad": the socket then goes to `closed` with
`auth-failure` instead of retrying.

**Alternative.** Fetch a token once; retry on every close.

**Why.** Tokens expire, so a reconnect with the old one fails forever. And retrying a rejected
login in a loop hammers the server and can lock an account, so the library stops and says why.

**Cost.** The library does not refresh tokens or decide what a "bad credentials" close code is:
you supply both (`url()` and `isAuthFailure`). A `url()` that throws counts as a failed attempt.

## 6. Subscriptions are reference-counted and replayed in a fixed order

**Chosen.** `subscribe(topic, handler)` keeps one entry per call in a `Map` of topic to listeners.
The first listener sends your `subscribe` message, the last one leaving sends `unsubscribe`. On
every new connection the order is: your `onOpen` messages, then every subscribed topic (in the order
it was first subscribed, which is the `Map`'s insertion order), then anything queued with
`queueWhileOffline`, and only then is the state set to `open`.

**Alternative.** Leave resubscribing to the application, or replay on the `open` event.

**Why.** A new connection starts empty on the server, so the client has to say again what it
listens to, and it has to be _after_ auth or the server rejects it. Announcing `open` last means a
state listener that calls `send()` or `subscribe()` cannot jump ahead of the replay or be replayed
twice. A topic that everyone left while the socket was offline is not replayed.

**Cost.** Delivery is at most once: a message sent while the connection dropped is not retried, and
nothing acknowledges it (there are no acknowledgements; see below).

## 7. `send()` throws when the socket is not open, unless you opt into a queue

**Chosen.** Without `queueWhileOffline: N`, `send()` while not open throws. With it, up to `N`
messages are queued and sent in order after the replay.

**Alternative.** Always queue, or silently drop.

**Why.** An unbounded hidden queue replays stale messages after a long outage and grows without
limit; silently dropping loses data without telling anyone. An error is honest, and a bounded queue
is an explicit choice you make for messages where being late is fine.

## 8. Lifecycle adapters are passed in, so the core imports nothing

**Chosen.** `lifecycle` is a function that receives `{ pause, wake }` and returns a cleanup.
`browserLifecycle()` uses `online`, `offline` and `visibilitychange`; `appStateLifecycle(AppState)`
takes React Native's `AppState` as an argument.

**Alternative.** Import `react-native` or touch `window` inside the core.

**Why.** The core has no dependencies and never imports `react-native`, so it runs on the web,
React Native and Node, and tests drive it with fakes. `offline` pauses retrying without using up
attempts; coming back (online, visible, active) wakes it.

**Cost.** One more line of setup for React Native, and no network-quality signal: see "Known
weaknesses".

## 9. React is a thin layer on `useSyncExternalStore`

**Chosen.** `useSocketState()` subscribes with `useSyncExternalStore` (the server snapshot is
`'idle'`, because there is no connection while rendering on the server). `useSubscription(topic,
handler)` keeps the latest handler in a ref, so passing a new function every render does not
resubscribe; it resubscribes only when the topic or the socket changes. `SocketProvider` does not
connect or close anything: you own the socket.

**Why.** `useSyncExternalStore` is React's own tool for external stores and avoids tearing in
concurrent rendering. The ref makes the common case (an inline handler) cheap and correct. A
subscribe/unsubscribe pair per effect is safe under Strict Mode.

**Cost.** The hooks take the message types as type arguments (`useSubscription<Incoming>(…)`)
instead of being generated from the socket's type; nothing checks them at runtime. A
`createSocketHooks` factory would remove that, at the price of a more complicated API; it is left
out until someone needs it.

## 10. Mistakes in your code do not break the connection

**Chosen.** Everything the socket calls on your behalf (`parse`, `isPong`, `topicOf`, message
handlers, state listeners) runs guarded. The error goes to `onError`, or, without it, is rethrown
from a timer so it is not swallowed.

**Why.** Found by testing against the `ws` package: an exception inside a message listener left the
connection open but deaf, and a throwing state listener could stop the heartbeat from starting.
Reporting instead of swallowing keeps real bugs visible; isolating keeps one bad handler from
starving the others.

## 11. Zero runtime dependencies, an injectable `WebSocket`

**Chosen.** The constructor is `options.WebSocket ?? globalThis.WebSocket`. If neither exists,
`createSocket` throws.

**Why.** Passing `ws` in Node and a fake in tests needs no mocking library, and the published
package stays at about 1.7 kB (core) plus 0.4 kB (React hooks) minified and gzipped.

**Cost.** On Node 20 there is no global `WebSocket`, so creating a socket at module level in
server-rendered code throws; see "Known weaknesses".

## 12. Tooling choices

TypeScript in strict mode plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`: the
options object has many optional members, and these two flags catch the most real mistakes with
them. Vitest with fake timers, because the whole library is about time. ESLint with
`strictTypeChecked`. `tsup` for ESM, CJS and types. Changesets for versions and changelog, publishing
from GitHub Actions with npm provenance and no long-lived token. `size-limit` fails CI if the core
grows past 3 kB.

## Known weaknesses

These are real, and most of them are on the roadmap or would be a small change.

- **Creating the socket inside an effect, and a final `close()`, are awkward in React.** A
  reopenable socket would remove the pattern, but also the simplicity of section 1.
- **Liveness is judged by pongs only** (section 3), so the heartbeat is unusable with a server that
  cannot answer a ping.
- **No acknowledgements or request and response.** Messages are at most once, with no ids and no
  timeouts. This is listed as possible later work.
- **No network-quality signal on mobile.** Airplane mode is noticed by the heartbeat, within about
  `interval + timeout`, not instantly; a `NetInfo` adapter is listed as possible later work.
- **Binary messages need a custom `parse`.** The default is `JSON.parse(String(data))`.
- **Creating a socket where there is no global `WebSocket`** (Node 20, server rendering) throws at
  construction. Looking the constructor up at `connect()` would be friendlier.
- **If `ping()` or `serialize` throws inside the heartbeat timer,** the error surfaces as an
  uncaught error from the timer; it does not break the state, but it is not routed to `onError`.
- **It is new.** Version 0.x, few users, and the API can still change before 1.0.

## Questions you will be asked

**Why not Socket.IO?** It needs a Socket.IO server; this is for plain WebSocket servers. See the
[comparison](./comparison.md) for what each library does and where Socket.IO is better.

**TCP has keepalive. Why a heartbeat?** The page cannot control it, the defaults are often hours,
and a NAT or proxy can drop a connection without either end being told.

**Why not WebSocket ping frames?** Browsers do not expose them to JavaScript.

**Why full jitter?** To spread a thundering herd after a server restart; it is the simplest variant
with a good spread, and `random` is injectable for tests.

**Is it safe in React Strict Mode?** Yes if the socket is created, connected and closed inside one
`useEffect` (the web demo does). The reason is section 1.

**What happens to messages sent while the connection was dropping?** Nothing: delivery is at most
once. Only subscriptions and messages queued with `queueWhileOffline` are sent again.

**What if the server accepts connections and drops them straight away?** The backoff keeps growing,
because a connection only resets it after `minUptime` (section 4).

**What if the server rejects the login?** If `isAuthFailure` matches the close code, the socket goes
to `closed` with `auth-failure` and stops; otherwise it keeps retrying with a fresh token each time.

**Why not RxJS or an event-emitter library?** The core has no dependencies; the pieces it needs
(a state, a few listener sets) are small.

**How is it tested?** The core with fake timers and a fake WebSocket (every transition), the demo
server's behaviours (a silent connection, a restart, an expired login) against a real `ws`
connection, and the web demo in a real browser.
