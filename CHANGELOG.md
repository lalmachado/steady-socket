# steady-socket

## 0.1.1

### Patch Changes

- 9d62e6f: Docs only: the README now shows the published status, an npm version badge and the current contributing commands.

## 0.1.0

### Minor Changes

- e40cdfc: First release. A WebSocket client with heartbeats that catch dead connections, reconnect with exponential backoff and full jitter, auth on every connection, reference-counted subscriptions replayed in order after auth, and app-lifecycle awareness for the web and React Native. Includes a React layer (`steady-socket/react`) and a React Native `AppState` adapter (`steady-socket/react-native`). Zero runtime dependencies.
