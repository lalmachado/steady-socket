---
'steady-socket': patch
---

A message that cannot be parsed, or a handler, listener, `isPong` or `topicOf` that throws, no longer breaks the connection. Before, an exception inside a message listener left the socket open but deaf under the `ws` package, stopped the other listeners from getting that message, and a throwing state listener could stop the heartbeat from starting. These errors now go to the new `onError` option, and the socket carries on. Without `onError` they are rethrown from a timer, so they are not swallowed.
