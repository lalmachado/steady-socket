/**
 * Drives the web demo in a real browser against the real demo server and checks that
 * steady-socket does what the README says. Not part of CI (it needs a browser): run it with
 * `pnpm --filter @steady-socket/demo-web e2e`.
 *
 * - `CHROMIUM_PATH` points at a Chromium binary. Without it, Playwright's own Chromium is used
 *   (install it once with `pnpm --filter @steady-socket/demo-web exec playwright-core install chromium`).
 * - `E2E_PUBLIC=1` starts the demo server in public mode, as it would run when deployed: the pages
 *   are cross-origin calls that the server only answers for their origins.
 * - `RECORD_DIR` also records a paced video of the run there, for making a GIF.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import {
  startDemoServer,
  type DemoServer,
  type DemoServerOptions,
} from '../../demo-server/src/server.js';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const SERVER_PORT = 8787; // the port the app is built to use
const PROD_PORT = 3100;
const DEV_PORT = 3101;
const ORIGINS = [`http://localhost:${String(PROD_PORT)}`, `http://localhost:${String(DEV_PORT)}`];
// Tokens that run out within seconds. A token is only for connecting, so a page must stay connected
// long after its token has expired: with the old "a token ends its connection" rule every page was
// thrown out after a minute, which no short test would have noticed.
const TOKEN_TTL_MS = 3000;

function serverOptions(overrides: Partial<DemoServerOptions> = {}): DemoServerOptions {
  return {
    port: SERVER_PORT,
    tokenTtlMs: TOKEN_TTL_MS,
    ...(process.env['E2E_PUBLIC'] ? { public: { allowedOrigins: ORIGINS } } : {}),
    ...overrides,
  };
}
const RECORD = process.env['RECORD_DIR'];
// A recording is paced so a person can follow it; a normal run goes as fast as it can.
const pause = (ms: number) => (RECORD ? sleep(ms) : Promise.resolve());

/**
 * Playwright's own video recorder needs a browser-bundled ffmpeg, so a recording is a series of
 * timestamped screenshots instead (the file name is the time in ms). ffmpeg turns them into a GIF.
 */
let stopFrames: (() => Promise<void>) | undefined;
function captureFrames(page: Page, dir: string): () => Promise<void> {
  const startedAt = Date.now();
  const state = { running: true };
  let index = 0;
  const loop = (async () => {
    while (state.running) {
      const at = Date.now() - startedAt;
      await page
        .screenshot({ path: `${dir}/${String(index++).padStart(5, '0')}-${String(at)}.png` })
        .catch(() => undefined);
      await sleep(40);
    }
  })();
  return async () => {
    state.running = false;
    await loop;
  };
}

let passed = 0;
const ok = (message: string) => {
  passed++;
  console.log(`  ok  ${message}`);
};

async function until(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<number> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for: ${label}`);
    await sleep(50);
  }
  return Date.now() - start;
}

const text = (page: Page, testId: string) => page.getByTestId(testId).innerText();
const stateOf = (page: Page) => text(page, 'state');
const score = async (page: Page) => Number(await text(page, 'score'));

async function startNext(mode: 'start' | 'dev', port: number): Promise<ChildProcess> {
  const child = spawn('pnpm', ['exec', 'next', mode, '-p', String(port)], {
    cwd: APP_DIR,
    stdio: 'ignore',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  await until(
    async () => {
      try {
        return (await fetch(`http://localhost:${String(port)}/`)).ok;
      } catch {
        return false;
      }
    },
    `next ${mode} to answer on :${String(port)}`,
    60_000,
  );
  return child;
}

async function openPage(
  browser: Browser,
  port: number,
): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  // A recording gets a taller frame, so the whole page fits.
  const context = await browser.newContext({
    viewport: { width: 960, height: RECORD ? 800 : 700 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Chromium logs every refused handshake and offline request. The scenarios cause those on
    // purpose (a restarting server, a browser that goes offline), so they are not errors here.
    if (
      /^WebSocket connection to .* failed/.test(text) ||
      text.includes('ERR_INTERNET_DISCONNECTED')
    )
      return;
    errors.push(text);
  });
  await page.goto(`http://localhost:${String(port)}/`);
  if (RECORD) stopFrames = captureFrames(page, RECORD);
  return { page, context, errors };
}

/** The production build: every scenario the demo server can throw at the client. */
async function scenarios(browser: Browser, server: DemoServer): Promise<void> {
  console.log('\nProduction build (next start)');

  const html = await (await fetch(`http://localhost:${String(PROD_PORT)}/`)).text();
  if (!html.includes('steady-socket') || !html.includes('starting'))
    throw new Error('The server-rendered HTML is not what was expected.');
  ok('the page is rendered on the server (the socket only exists in the browser)');

  const { page, context, errors } = await openPage(browser, PROD_PORT);
  await until(async () => (await stateOf(page)) === 'open', 'the state to become open');
  ok('connects and reaches "open"');

  await until(async () => (await score(page)) > 0, 'the first event');
  const first = await score(page);
  await until(async () => (await score(page)) > first, 'the score to advance');
  ok('the subscription delivers events');
  if (server.state().connections !== 1 || server.state().topics['match:42'] !== 1)
    throw new Error('Expected one connection and one listener.');
  ok('the server sees one connection with one listener');
  if (!RECORD) {
    await sleep(TOKEN_TTL_MS + 1500);
    if ((await stateOf(page)) !== 'open')
      throw new Error('The page was thrown out when its token ran out.');
    ok('the page stays connected after its token has run out (a token is only for connecting)');
  }
  await pause(2500);

  // 1. A connection that stays open but goes silent: only the heartbeat can notice.
  await page.getByRole('button', { name: 'Go silent (dead connection)' }).click();
  const noticed = await until(
    async () => (await stateOf(page)) !== 'open',
    'the heartbeat to notice',
    8000,
  );
  ok(`a silent-but-open connection is noticed by the heartbeat (after ${String(noticed)} ms)`);
  await pause(4000);
  await page.getByRole('button', { name: 'Answer again' }).click();
  await until(async () => (await stateOf(page)) === 'open', 'the state to become open again');
  const afterSilent = await score(page);
  await until(async () => (await score(page)) > afterSilent, 'events to flow again');
  ok('recovers when the server answers again, and the topic is subscribed again');
  await until(
    () => server.state().connections === 1 && server.state().topics['match:42'] === 1,
    'exactly one listener',
    5000,
  );
  ok('without leaving a stale connection or a duplicate listener behind');
  await pause(2000);

  // 2. A server restart: refused connections for 5 s.
  await page.getByRole('button', { name: 'Restart server (5 s)' }).click();
  await until(
    async () => (await stateOf(page)) === 'reconnecting',
    'the client to notice the restart',
    5000,
  );
  ok('a server restart drops the connection and the client goes to "reconnecting"');
  await sleep(2500);
  if ((await stateOf(page)) === 'open')
    throw new Error('The client claims to be open while the server refuses connections.');
  ok('it keeps retrying (and never claims "open") while the server refuses connections');
  await until(
    async () => (await page.getByTestId('waking').count()) > 0,
    'the page to explain the wait',
    4000,
  );
  ok('after a few seconds without a connection the page explains that the server may be waking up');
  const recovered = await until(
    async () => (await stateOf(page)) === 'open',
    'recovery after the restart',
    20_000,
  );
  const before = await score(page);
  if ((await page.getByTestId('waking').count()) > 0)
    throw new Error('The waiting hint is still shown after the connection came back.');
  await until(async () => (await score(page)) > before, 'events after the restart');
  ok(
    `recovers by itself after the restart (${String(recovered)} ms after the retry window began) and subscribes again`,
  );
  await pause(2000);

  // 3. Expired tokens: stop, do not loop.
  await page.getByRole('button', { name: 'Expire tokens' }).click();
  await until(async () => (await stateOf(page)) === 'closed', 'the socket to close', 5000);
  if (!(await text(page, 'reason')).includes('auth-failure'))
    throw new Error('Expected the close reason to be auth-failure.');
  ok('expired tokens end in "closed" with the reason "auth-failure"');
  await sleep(1500);
  if (server.state().connections !== 0)
    throw new Error('The client kept connecting after an auth failure.');
  ok('and it does not retry: the server sees no new connection');
  await pause(2500);
  await page.getByRole('button', { name: 'Sign in again' }).click();
  await until(async () => (await stateOf(page)) === 'open', 'the new socket to open');
  await until(
    () => server.state().connections === 1 && server.state().topics['match:42'] === 1,
    'one connection, one listener',
    5000,
  );
  ok('"Sign in again" makes a new socket that connects with a fresh token');
  await pause(2500);

  // 4. The browser going offline and coming back (browserLifecycle).
  await context.setOffline(true);
  const wentBad = await until(
    async () => (await stateOf(page)) !== 'open',
    'the client to react to being offline',
    12_000,
  ).then(
    () => true,
    () => false,
  );
  if (wentBad) {
    ok('going offline is noticed');
    await context.setOffline(false);
    const back = await until(
      async () => (await stateOf(page)) === 'open',
      'recovery after going back online',
      10_000,
    );
    ok(`coming back online reconnects (${String(back)} ms)`);
  } else {
    await context.setOffline(false);
    console.log('  --  offline emulation did not interrupt the open WebSocket here (not asserted)');
  }

  if (errors.length > 0) throw new Error(`The page logged errors:\n${errors.join('\n')}`);
  ok('no errors in the browser console during any of this');
  await stopFrames?.();
  await context.close();
}

/** Two visitors at once: what one does to "the server" must not reach the other. */
async function isolation(browser: Browser, server: DemoServer): Promise<void> {
  console.log('\nTwo visitors at the same time');
  const one = await openPage(browser, PROD_PORT);
  const two = await openPage(browser, PROD_PORT);
  for (const { page } of [one, two]) {
    await until(async () => (await stateOf(page)) === 'open', 'the state to become open');
    await until(async () => (await score(page)) > 0, 'the first event');
  }
  await until(() => server.state().connections === 2, 'two connections');
  ok('two pages are two sessions: the server sees two connections');

  // Visitor one restarts "the server", and then makes their connection go silent.
  await one.page.getByRole('button', { name: 'Restart server (5 s)' }).click();
  await until(async () => (await stateOf(one.page)) === 'reconnecting', 'visitor one to notice');
  const before = await score(two.page);
  await sleep(2500);
  if ((await stateOf(two.page)) !== 'open') throw new Error('The restart reached the other page.');
  await until(async () => (await score(two.page)) > before, 'events for visitor two');
  ok("one visitor's server restart does not touch the other visitor");
  await until(async () => (await stateOf(one.page)) === 'open', 'visitor one to recover', 20_000);

  await one.page.getByRole('button', { name: 'Go silent (dead connection)' }).click();
  await until(async () => (await stateOf(one.page)) !== 'open', 'the heartbeat to notice', 8000);
  const during = await score(two.page);
  await until(async () => (await score(two.page)) > during, 'events for visitor two');
  if ((await stateOf(two.page)) !== 'open') throw new Error('The silence reached the other page.');
  ok("and one visitor's dead connection does not touch the other either");

  for (const { errors } of [one, two]) {
    if (errors.length > 0) throw new Error(`The page logged errors:\n${errors.join('\n')}`);
  }
  await one.context.close();
  await two.context.close();
}

/** A server with room for one visitor: the second must be told it is busy, and get in later. */
async function busy(browser: Browser, server: DemoServer): Promise<DemoServer> {
  console.log('\nA full server');
  await server.close();
  const small = await startDemoServer(
    serverOptions({
      tokenTtlMs: 1000,
      sweepMs: 200,
      public: { allowedOrigins: ORIGINS, maxSessions: 1 },
    }),
  );
  const one = await openPage(browser, PROD_PORT);
  await until(async () => (await stateOf(one.page)) === 'open', 'the first visitor to get in');
  const two = await openPage(browser, PROD_PORT);
  await until(
    async () => (await two.page.getByTestId('busy').count()) > 0,
    'the page to say the demo is busy',
    15_000,
  );
  if ((await stateOf(two.page)) === 'closed')
    throw new Error('A full server ended the socket as if the login had failed.');
  ok('when the server is full the page says it is busy, and the socket keeps trying');
  await one.context.close();
  await until(
    async () => (await stateOf(two.page)) === 'open',
    'the second visitor to get in once there is room',
    30_000,
  );
  ok('and the second visitor gets in by itself as soon as there is room');
  await two.context.close();
  await small.close();
  return startDemoServer(serverOptions());
}

/** `next dev` runs React Strict Mode, which runs every effect, cleans it up and runs it again. */
async function strictMode(browser: Browser, server: DemoServer): Promise<void> {
  console.log('\nDevelopment server (next dev, React Strict Mode)');
  const { page, context, errors } = await openPage(browser, DEV_PORT);
  await until(async () => (await stateOf(page)) === 'open', 'the state to become open', 30_000);
  await sleep(1500);
  const { connections, topics } = server.state();
  if (connections !== 1 || topics['match:42'] !== 1) {
    throw new Error(
      `Strict Mode left ${String(connections)} connections and ${String(topics['match:42'] ?? 0)} listeners (expected 1 and 1).`,
    );
  }
  ok('Strict Mode double-running the effect leaves exactly one live socket and one listener');
  if (errors.length > 0) throw new Error(`The page logged errors:\n${errors.join('\n')}`);
  ok('and no errors in the console');
  await context.close();
}

async function main(): Promise<void> {
  const children: ChildProcess[] = [];
  let server: DemoServer | undefined;
  let browser: Browser | undefined;
  try {
    server = await startDemoServer(serverOptions());
    children.push(await startNext('start', PROD_PORT));
    browser = await chromium.launch({
      ...(process.env['CHROMIUM_PATH'] ? { executablePath: process.env['CHROMIUM_PATH'] } : {}),
    });
    await scenarios(browser, server);
    if (!RECORD) {
      await isolation(browser, server);
      server = await busy(browser, server);
      // Stop the production server first: both servers write to the same `.next` directory.
      children.pop()?.kill('SIGTERM');
      await sleep(500);
      children.push(await startNext('dev', DEV_PORT));
      await strictMode(browser, server);
    }
    console.log(`\nAll ${String(passed)} checks passed.`);
  } catch (error) {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    for (const child of children) child.kill('SIGTERM');
    await server?.close();
  }
}

void main();
