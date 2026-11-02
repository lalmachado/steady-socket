---
'steady-socket': minor
---

New `reconnect.minUptime` option (default 5000 ms). A connection now resets the backoff only after it has stayed open that long. Before, the backoff reset as soon as a connection opened, so a server that accepted connections and dropped them at once was retried at the shortest delay for ever (18 to 20 connections in 5 seconds with the default settings; 5 now, and the delay keeps growing). A connection that drops sooner counts as a failed attempt, also towards `maxAttempts`. Set `minUptime: 0` for the old behaviour.
