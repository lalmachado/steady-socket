# steady-socket

## 0.1.2

### Patch Changes

- 217f858: A message that cannot be parsed, or a handler, listener, `isPong` or `topicOf` that throws, no longer breaks the connection. Before, an exception inside a message listener left the socket open but deaf under the `ws` package, stopped the other listeners from getting that message, and a throwing state listener could stop the heartbeat from starting. These errors now go to the new `onError` option, and the socket carries on. Without `onError` they are rethrown from a timer, so they are not swallowed.

## 0.1.1

### Patch Changes

- 9d62e6f: Docs only: the README now shows the published status, an npm version badge and the current contributing commands.

## 0.1.0

### Minor Changes

- e40cdfc: First release. A WebSocket client with heartbeats that catch dead connections, reconnect with exponential backoff and full jitter, auth on every connection, reference-counted subscriptions replayed in order after auth, and app-lifecycle awareness for the web and React Native. Includes a React layer (`steady-socket/react`) and a React Native `AppState` adapter (`steady-socket/react-native`). Zero runtime dependencies.
