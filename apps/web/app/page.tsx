import { Demo } from './demo';

// A server component: it renders on the server, and `Demo` (a client component) takes over in the
// browser. The socket only ever exists in the browser.
export default function Page() {
  return (
    <main>
      <h1>steady-socket</h1>
      <p>
        A WebSocket client that stays connected. Break the connection below and watch it recover.
        The server is <code>apps/demo-server</code>, started with{' '}
        <code>pnpm --filter @steady-socket/demo-server start</code>.
      </p>
      <Demo />
    </main>
  );
}
