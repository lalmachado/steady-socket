/**
 * A load test for the demo server: many visitors, each with their own session, doing what the web
 * demo does (get a token, connect, subscribe, ping every 2 s) and measuring how long the pongs
 * take. A pong later than the demo's heartbeat timeout (1 s) is a connection `steady-socket`
 * would call dead, so the report counts those.
 *
 *   pnpm --filter @steady-socket/demo-server load -- <http-url> [connections] [seconds] [poll-ms]
 *
 * Like the web page, every visitor also asks `GET /state` every `poll-ms` (default 500; 0 turns it
 * off), because that is real load too.
 *
 * It is a tool for sizing the limits of a public server, not a benchmark of `steady-socket`.
 */
import WebSocket from 'ws';
import { rawToString } from '../src/server.js';

// `pnpm run load -- <args>` passes the `--` on to the script, so drop it.
const [base = 'http://127.0.0.1:8787', connectionsArg = '200', secondsArg = '30', pollArg = '500'] =
  process.argv.slice(2).filter((arg) => arg !== '--');
const target = Number(connectionsArg);
const seconds = Number(secondsArg);
const pollMs = Number(pollArg);
const wsBase = base.replace(/^http/, 'ws');
const PING_EVERY_MS = 2000;
const PONG_TIMEOUT_MS = 1000;
const RAMP_PER_SECOND = 40;

const latencies: number[] = [];
const stateLatencies: number[] = [];
let stateFailures = 0;
let connected = 0;
let refused = 0;
const reasons = new Map<string, number>();
const refuse = (reason: string) => {
  refused++;
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
};
let dropped = 0;
let late = 0;
let events = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sessionId = (n: number) => `load${String(n).padStart(8, '0')}`;

function visitor(n: number): WebSocket | undefined {
  // Resolved below; a refused token or handshake just counts as a refusal.
  void (async () => {
    let response: Response;
    try {
      response = await fetch(`${base}/token?session=${sessionId(n)}`);
    } catch (error) {
      refuse(
        `token request failed: ${error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : 'unknown'}`,
      );
      return;
    }
    if (!response.ok) {
      refuse(`token request answered ${String(response.status)}`);
      return;
    }
    const { token } = (await response.json()) as { token: string };
    const ws = new WebSocket(`${wsBase}/?token=${token}`);
    let pingSentAt = 0;
    let timer: NodeJS.Timeout | undefined;
    ws.on('open', () => {
      connected++;
      ws.send(JSON.stringify({ type: 'subscribe', topic: 'clock' }));
      timer = setInterval(() => {
        pingSentAt = Date.now();
        ws.send(JSON.stringify({ type: 'ping' }));
      }, PING_EVERY_MS);
    });
    if (pollMs > 0) {
      const poll = setInterval(() => {
        const askedAt = Date.now();
        fetch(`${base}/state?session=${sessionId(n)}`)
          .then(async (r) => {
            await r.text();
            if (r.ok) stateLatencies.push(Date.now() - askedAt);
            else stateFailures++;
          })
          .catch(() => {
            stateFailures++;
          });
      }, pollMs);
      ws.on('close', () => {
        clearInterval(poll);
      });
    }
    ws.on('message', (raw) => {
      const message = JSON.parse(rawToString(raw)) as { type: string };
      if (message.type === 'event') events++;
      if (message.type === 'pong' && pingSentAt > 0) {
        const took = Date.now() - pingSentAt;
        latencies.push(took);
        if (took > PONG_TIMEOUT_MS) late++;
        pingSentAt = 0;
      }
    });
    ws.on('error', (error) => {
      refuse(`websocket error: ${error.message}`);
    });
    ws.on('close', () => {
      clearInterval(timer);
      dropped++;
    });
    sockets.push(ws);
  })();
  return undefined;
}

const sockets: WebSocket[] = [];

async function main(): Promise<void> {
  console.log(`${String(target)} visitors to ${base}, ${String(seconds)} s once connected`);
  for (let n = 0; n < target; n++) {
    visitor(n);
    if ((n + 1) % RAMP_PER_SECOND === 0) await sleep(1000);
  }
  await sleep(3000); // let the last ones connect
  console.log(`connected ${String(connected)}, refused ${String(refused)}`);
  for (const [reason, count] of reasons) console.log(`  ${String(count)} x ${reason}`);
  const startedAt = Date.now();
  const eventsBefore = events;
  latencies.length = 0;
  late = 0; // only the pongs of the measured window, not the rush while visitors were arriving
  stateLatencies.length = 0;
  stateFailures = 0;
  await sleep(seconds * 1000);
  const elapsed = (Date.now() - startedAt) / 1000;

  latencies.sort((a, b) => a - b);
  stateLatencies.sort((a, b) => a - b);
  const at = (q: number, from = latencies) =>
    from[Math.min(from.length - 1, Math.floor(q * from.length))] ?? 0;
  console.log(
    [
      `pongs measured: ${String(latencies.length)}`,
      `latency ms: p50 ${String(at(0.5))}, p95 ${String(at(0.95))}, p99 ${String(at(0.99))}, max ${String(latencies.at(-1) ?? 0)}`,
      `pongs later than ${String(PONG_TIMEOUT_MS)} ms (a dead connection to the demo's heartbeat): ${String(late)}`,
      ...(pollMs > 0
        ? [
            `GET /state every ${String(pollMs)} ms per visitor: ${String(stateLatencies.length)} answered, ${String(stateFailures)} failed; ms: p50 ${String(at(0.5, stateLatencies))}, p95 ${String(at(0.95, stateLatencies))}, p99 ${String(at(0.99, stateLatencies))}`,
          ]
        : []),
      `connections dropped by the server during the test: ${String(dropped)}`,
      `events received: ${String(Math.round((events - eventsBefore) / elapsed))} per second in total`,
    ].join('\n'),
  );
  for (const ws of sockets) ws.terminate();
  process.exit(0);
}

void main();
