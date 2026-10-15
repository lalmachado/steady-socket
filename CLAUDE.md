# steady-socket — notes for Claude

## What this is

A small open-source TypeScript library: a WebSocket client with heartbeats, reconnect with backoff and jitter, auth on every connection, subscription replay, and app-lifecycle awareness for the web and React Native. See `README.md` for the target v0.1 API and `ROADMAP.md` for the plan, split into sessions.

The author is Luís Machado, a senior front-end and React Native engineer. This is a public portfolio project. Its value depends on two things: the code is clean and idiomatic, and **Luís can explain and defend every line in a technical interview.**

## How to work on this repo

- **Follow `ROADMAP.md` in order**, one session at a time. Tick the boxes in `ROADMAP.md` as items are done, in the same PR.
- **Small PRs.** One roadmap session per PR at most, smaller when a session is large. Luís reviews everything before merging.
- **Explain the non-obvious.** In each PR description, give a short "Decisions" list: what was chosen, the alternative, and why. For example, why full jitter, or why `useSyncExternalStore`. These double as interview prep.
- **Don't build ahead.** Nothing from "After v0.1" until v0.1 ships.
- **Keep `README.md` honest.** It describes the target API and is marked pre-release. When the real API differs, update the README in the same PR. Never describe a feature as working before it's built and tested.
- **Written from scratch.** Don't reproduce code from other WebSocket libraries. Reading them for comparison is fine (Session 0 asks for it); copying isn't.

## Technical choices (already decided)

- Node 22 (`.nvmrc`), pnpm for development
- TypeScript strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- Zero runtime dependencies in the core. `react` is an optional peer dependency. Never import `react-native`: React Native APIs such as `AppState` are passed in by the user
- Subpath exports: `.`, `./react`, `./react-native`
- Build: `tsup` (ESM + CJS + `.d.ts`). Tests: Vitest with fake timers, plus React Testing Library for hooks. Lint: ESLint with typescript-eslint, and Prettier
- The `WebSocket` constructor is injectable, which is how tests use a `FakeWebSocket`
- Releases: Changesets, published from GitHub Actions with npm provenance
- Package checks in CI: `publint` and `@arethetypeswrong/cli`

## Commits

Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`, `ci:`).
