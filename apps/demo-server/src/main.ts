import { startDemoServer } from './server.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '127.0.0.1';

const server = await startDemoServer({ port, host });

const base = `http://${host === '0.0.0.0' ? 'localhost' : host}:${String(server.port)}`;
console.log(`steady-socket demo server on ws://${host}:${String(server.port)}`);
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

process.on('SIGINT', () => {
  void server.close().then(() => process.exit(0));
});
