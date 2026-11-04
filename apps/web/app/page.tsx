import { Demo } from './demo';

// A server component: it renders on the server, and `Demo` (a client component) takes over in the
// browser. The socket only ever exists in the browser.
export default function Page() {
  return (
    <main>
      <h1>steady-socket</h1>
      <p>
        A WebSocket client that stays connected. This page shows the clock of a demo server, which
        sends the time every second. Break the connection with the buttons below: the clock freezes,
        and steady-socket notices, reconnects and subscribes again by itself, so it catches up.
      </p>
      <p>
        <a href="https://github.com/lalmachado/steady-socket">Source and docs on GitHub</a> ·{' '}
        <a href="https://www.npmjs.com/package/steady-socket">npm</a>
      </p>
      <Demo />
    </main>
  );
}
