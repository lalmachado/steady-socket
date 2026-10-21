'use client';

import { useCallback, useEffect, useState } from 'react';
import { SocketProvider, useSocket, useSocketState, useSubscription } from 'steady-socket/react';
import { createDemoSocket, SERVER, type DemoSocket, type Incoming, type Outgoing } from './socket';

interface LogEntry {
  at: number;
  text: string;
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export function Demo() {
  // Bumping this makes a brand new socket. A closed socket is finished for good (by design), so
  // "sign in again" after an auth failure means a new one.
  const [session, setSession] = useState(1);
  const [socket, setSocket] = useState<DemoSocket | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const note = useCallback((text: string) => {
    setLog((entries) => [...entries.slice(-7), { at: Date.now(), text }]);
  }, []);

  useEffect(() => {
    // Create, connect and close the socket together, in one effect. Not at module level: that
    // would also run on the server. And not "create once, connect and close in an effect": React
    // Strict Mode runs an effect, cleans it up and runs it again, and `close()` is final.
    const created = createDemoSocket();
    // Listen before connecting, so the log starts at `connecting`.
    const stopLogging = created.onState((state) => {
      note(created.closeReason ? `${state} (${created.closeReason})` : state);
    });
    created.connect();
    setSocket(created);
    return () => {
      stopLogging();
      created.close();
    };
  }, [session, note]);

  if (!socket) {
    // What the server renders, and what the browser shows until the effect has run.
    return (
      <section className="card">
        <div className="badge" data-testid="state">
          <span className="dot" data-state="idle" />
          <span>starting…</span>
        </div>
      </section>
    );
  }

  return (
    <SocketProvider socket={socket}>
      <div className="grid">
        <StateCard />
        <PositionCard />
      </div>
      <Controls
        onSignInAgain={() => {
          setSession((n) => n + 1);
        }}
        note={note}
      />
      <div className="grid">
        <section className="card">
          <h2>State changes</h2>
          <ul className="log" data-testid="log">
            {log.map((entry, index) => (
              <li key={`${String(entry.at)}-${String(index)}`}>
                <time>{time(entry.at)}</time>
                <span>{entry.text}</span>
              </li>
            ))}
          </ul>
        </section>
        <ServerCard />
      </div>
    </SocketProvider>
  );
}

function StateCard() {
  const socket = useSocket<Incoming, Outgoing>();
  const state = useSocketState();
  return (
    <section className="card">
      <h2>Connection</h2>
      <div className="badge" data-testid="state">
        <span className="dot" data-state={state} />
        <span>{state}</span>
      </div>
      {state === 'closed' && (
        <div className="reason" data-testid="reason">
          closed: {socket.closeReason}
        </div>
      )}
    </section>
  );
}

function PositionCard() {
  const [position, setPosition] = useState<number>();
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [now, setNow] = useState(() => Date.now());

  // The topic is subscribed on mount and again, by the library, after every reconnect.
  useSubscription<Incoming>('bed:42', (message) => {
    if (message.type !== 'event') return;
    setPosition(message.payload.position);
    setUpdatedAt(Date.now());
  });

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const age =
    updatedAt === undefined ? undefined : Math.max(0, Math.round((now - updatedAt) / 1000));
  return (
    <section className="card">
      <h2>Bed 42 position</h2>
      <div className="big" data-testid="position">
        {position ?? '–'}
      </div>
      <div className="muted">
        {age === undefined ? 'waiting for the first event' : `updated ${String(age)} s ago`}
      </div>
    </section>
  );
}

function Controls({
  onSignInAgain,
  note,
}: {
  onSignInAgain: () => void;
  note: (text: string) => void;
}) {
  const state = useSocketState();

  const call = (path: string, label: string) => async () => {
    note(`you: ${label}`);
    try {
      await fetch(`${SERVER}${path}`, { method: 'POST' });
    } catch {
      note('the demo server is not reachable');
    }
  };

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <h2>Break it</h2>
      <div className="buttons">
        <button onClick={() => void call('/control/silent', 'server goes silent')()}>
          Go silent (dead connection)
        </button>
        <button onClick={() => void call('/control/silent?on=false', 'server answers again')()}>
          Answer again
        </button>
        <button onClick={() => void call('/control/restart?downMs=5000', 'server restarts, 5 s')()}>
          Restart server (5 s)
        </button>
        <button onClick={() => void call('/control/expire-token', 'tokens expire')()}>
          Expire tokens
        </button>
        {state === 'closed' && (
          <button className="primary" onClick={onSignInAgain}>
            Sign in again
          </button>
        )}
      </div>
    </section>
  );
}

interface ServerState {
  connections: number;
  silent: boolean;
  down: boolean;
  topics: Record<string, number>;
}

/** What the server sees, polled twice a second, so you can compare it with what the client shows. */
function ServerCard() {
  const [server, setServer] = useState<ServerState | 'unreachable'>();

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${SERVER}/state`);
        const body = (await response.json()) as ServerState;
        if (!cancelled) setServer(body);
      } catch {
        if (!cancelled) setServer('unreachable');
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <section className="card">
      <h2>What the server sees</h2>
      {server === undefined && <div className="muted">…</div>}
      {server === 'unreachable' && <div className="reason">demo server not reachable</div>}
      {typeof server === 'object' && (
        <dl data-testid="server">
          <dt>connections</dt>
          <dd data-testid="server-connections">{server.connections}</dd>
          <dt>silent</dt>
          <dd>{String(server.silent)}</dd>
          <dt>refusing connections</dt>
          <dd>{String(server.down)}</dd>
          <dt>listeners on bed:42</dt>
          <dd data-testid="server-listeners">{server.topics['bed:42'] ?? 0}</dd>
        </dl>
      )}
    </section>
  );
}
