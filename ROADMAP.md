# Roadmap

## v0.1 — the goal

A small, finished, published package: a dependency-free TypeScript core, a thin React layer, a React Native lifecycle adapter, real tests, CI, and automated releases to npm.

"Done" means all of this is true:

- [x] `npm install steady-socket` works, and the README examples run as written
- [x] Every connection state transition is covered by a test
- [x] CI is green on every PR: lint, typecheck, test and build
- [x] The package passes `publint` and `@arethetypeswrong/cli` (correct ESM/CJS exports and types)
- [x] Releases go out through Changesets and GitHub Actions, with npm provenance
- [x] The README states plainly what this does that the alternatives don't

Rough size: four or five working sessions (weekends or evenings).

---

## Session 0 — Positioning check (≈1 hour, before writing code)

The closest existing libraries are `partysocket` (actively maintained, has React hooks), `reconnecting-websocket` (no release since 2022) and `react-use-websocket` (React only).

- [x] Read the docs and source of `partysocket` and `react-use-websocket`. For each, note whether it has: heartbeat with dead-socket detection, subscription replay after reconnect, an auth step that runs before replay, auth-failure stop, React Native foreground handling, and an observable state machine
- [x] Keep only the README "Why" points that hold up after that check. If `partysocket` already does most of it, narrow the pitch to what's left (likely subscription replay ordering plus mobile lifecycle) rather than claiming a broader gap
- [x] Confirm the name `steady-socket` is still free on npm and on GitHub

## Session 1 — Repo and tooling

- [x] `git init`, MIT licence, `.editorconfig`, `.nvmrc` (Node 22)
- [x] `package.json` with `exports` for `.`, `./react`, `./react-native`; `sideEffects: false`; `react` as an optional peer dependency
- [x] TypeScript in strict mode, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- [x] Build with `tsup`: ESM + CJS + `.d.ts`
- [x] Vitest, ESLint (typescript-eslint), Prettier
- [x] GitHub Actions `ci.yml`: install, lint, typecheck, test, build, `publint`, `attw --pack`, on Node 20 and 22
- [x] Branch protection on `main`: CI must pass

## Session 2 — Core: connection and reconnect

- [x] `FakeWebSocket` test helper: can open, close with a code, deliver messages, and go silent
- [x] State machine: `idle → connecting → open → reconnecting → closed`, with `socket.state` and `onState`
- [x] Async `url` provider, called on every connect
- [x] Backoff: exponential, capped, full jitter, `maxAttempts`. Tested with fake timers and an injected random function
- [x] `close()` from any state cancels pending timers and never reconnects
- [x] `send()` while not open: throw by default, or queue up to a limit if `queueWhileOffline` is set (decide which and document it)

## Session 3 — Core: heartbeat, auth, subscriptions

- [x] Heartbeat: ping every `interval`; no pong within `timeout` → close and reconnect. Test the "open but silent" socket
- [x] `onOpen` hook runs before replay; messages sent in it go out first
- [x] `isAuthFailure` → `closed` with a reason, no retry loop
- [x] Subscriptions: reference-counted per topic (two listeners, one `subscribe` message), replayed in order after every reconnect, `unsubscribe` sent when the last listener leaves
- [x] Typed messages through generics `createSocket<Incoming, Outgoing>`

## Session 4 — React, React Native, browser lifecycle

- [x] `SocketProvider`, `useSocket`, `useSocketState` (`useSyncExternalStore`), `useSubscription` (stable across new handler identities, safe under React Strict Mode double effects)
- [x] Tests with React Testing Library
- [x] `browserLifecycle()`: `online` → reconnect now, `offline` → pause, `visibilitychange` → check health when visible
- [x] `appStateLifecycle(AppState)`: back to `active` → skip the backoff wait and send a ping straight away
- [x] Size budget with `size-limit` in CI (target: core under 3 kB min+gzip)

## Session 5 — Release

- [x] Changesets set up; release workflow on `main` opens a "Version packages" PR and publishes on merge
- [x] npm trusted publishing (OIDC) with provenance, so there's no npm token stored in GitHub
- [x] README examples checked by hand against the built package
- [x] Publish `0.1.0`, tag it, write a short GitHub release note
- [ ] Pin the repo on your GitHub profile

---

## After v0.1

**Phase two: demos.** Demo apps live in `apps/*` as private pnpm workspace members; the published package stays at the repo root. Moving it to `packages/steady-socket` is possible later but not needed.

- [x] `apps/demo-server`: a tiny `ws` server that can simulate a dead connection, a restart, and an expired token
- [x] `apps/web` (Next.js App Router): the README's React example against the demo server, with an end-to-end check in a real browser and a GIF
- [ ] `apps/mobile` (Expo): the same, with `appStateLifecycle`
- [ ] A short GIF of the Expo app reconnecting after airplane mode

**Possible later work:**

- Message acknowledgements and request/response with timeouts
- A devtools panel showing state transitions
- `NetInfo` adapter for React Native

**Out of scope:** Socket.IO compatibility, server-side code, binary protocols beyond what `serialize`/`parse` allow.

---

## When it's published

- Add one line to both CVs under an "Open source" label, with the npm link
- Add it to the dossier (only what's actually built and shipped)
- Be ready to explain in an interview: why full jitter, why the heartbeat is needed even though TCP has keepalive, how replay ordering avoids a race with auth, and how React Strict Mode affects `useSubscription`
