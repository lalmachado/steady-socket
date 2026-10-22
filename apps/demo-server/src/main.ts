import { startDemoServer } from './server.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '127.0.0.1';
// Setting ALLOWED_ORIGINS (comma separated) turns on public mode: see the README.
const origins = (process.env['ALLOWED_ORIGINS'] ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin !== '');

// A hosted server must never fall back to the open, shared playground because a variable is empty.
if (process.env['REQUIRE_ALLOWED_ORIGINS'] === '1' && origins.length === 0) {
  console.error(
    'ALLOWED_ORIGINS is empty. Set it to the origin of the page that uses this server.',
  );
  process.exit(1);
}

const server = await startDemoServer({
  port,
  host,
  ...(origins.length > 0 ? { public: { allowedOrigins: origins } } : {}),
});

const base = `http://${host === '0.0.0.0' ? 'localhost' : host}:${String(server.port)}`;
console.log(`steady-socket demo server on ws://${host}:${String(server.port)}`);
if (origins.length > 0) {
  console.log(
    `Public mode. Pages from ${origins.join(', ')} may use it; every call needs a session.`,
  );
} else {
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(
      'Listening beyond localhost. This server has no real security: use a trusted network.',
    );
  }
  console.log(`
Make it misbehave (HTTP, same port):
  curl ${base}/state
  curl -X POST ${base}/control/silent               # stay connected, answer nothing
  curl -X POST "${base}/control/silent?on=false"    # answer again
  curl -X POST "${base}/control/restart?downMs=5000" # drop everyone, refuse new connections for 5 s
  curl -X POST ${base}/control/expire-token         # close everyone with 4401
`);
}

// Ctrl-C on a laptop, SIGTERM from a container host: stop cleanly in both cases.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
