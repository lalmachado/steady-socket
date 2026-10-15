import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserLifecycle, type BrowserEnvironment, type LifecycleControls } from '../src';
import { appStateLifecycle, type AppStateLike } from '../src/react-native';
import { FakeWebSocket } from './helpers/fake-websocket';
import { setup, type Msg } from './helpers/setup';

const heartbeat = {
  interval: 10_000,
  timeout: 3000,
  ping: (): Msg => ({ type: 'ping' }),
  isPong: (m: Msg) => m.type === 'pong',
};
const PING = '{"type":"ping"}';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A lifecycle the test drives by hand, to test the socket's pause/wake on their own. */
function manualLifecycle() {
  const controls: LifecycleControls = { pause: () => undefined, wake: () => undefined };
  const detach = vi.fn();
  const lifecycle = vi.fn((c: LifecycleControls) => {
    controls.pause = c.pause;
    controls.wake = c.wake;
    return detach;
  });
  return { controls, detach, lifecycle };
}

async function openSocket(overrides = {}) {
  const ctx = setup(overrides);
  ctx.socket.connect();
  await vi.advanceTimersByTimeAsync(0);
  FakeWebSocket.last.open();
  await vi.advanceTimersByTimeAsync(0);
  return ctx;
}

describe('the lifecycle option', () => {
  it('is attached on connect(), not when the socket is created', () => {
    const { lifecycle } = manualLifecycle();
    const { socket } = setup({ lifecycle });
    expect(lifecycle).not.toHaveBeenCalled();
    socket.connect();
    socket.connect();
    expect(lifecycle).toHaveBeenCalledTimes(1);
  });

  it('is detached on close(), once', async () => {
    const { lifecycle, detach } = manualLifecycle();
    const { socket } = await openSocket({ lifecycle });
    socket.close();
    socket.close();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('is detached when the socket gives up on its own', async () => {
    const { lifecycle, detach } = manualLifecycle();
    const { socket } = setup({ lifecycle, isAuthFailure: () => true });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose(4401);
    expect(socket.state).toBe('closed');
    expect(detach).toHaveBeenCalledTimes(1);
  });
});

describe('wake()', () => {
  it('while reconnecting: skips the backoff wait and connects at once', async () => {
    const { lifecycle, controls } = manualLifecycle();
    const { socket } = await openSocket({ lifecycle });
    FakeWebSocket.last.serverClose();
    expect(socket.state).toBe('reconnecting');
    controls.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('connecting');
    expect(FakeWebSocket.instances).toHaveLength(2);
    // The cancelled backoff timer must not start a third connection later.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('while open with a heartbeat: pings straight away', async () => {
    const { lifecycle, controls } = manualLifecycle();
    await openSocket({ lifecycle, heartbeat });
    expect(FakeWebSocket.last.sent).toEqual([]);
    controls.wake();
    expect(FakeWebSocket.last.sent).toEqual([PING]);
  });

  it('while open with a heartbeat and no pong: the dead connection is replaced', async () => {
    const { lifecycle, controls } = manualLifecycle();
    const { socket } = await openSocket({ lifecycle, heartbeat });
    FakeWebSocket.last.goSilent();
    controls.wake();
    await vi.advanceTimersByTimeAsync(3000);
    expect(socket.state).toBe('reconnecting');
  });

  it('while open: does not stack a second ping on one that is waiting for its pong', async () => {
    const { lifecycle, controls } = manualLifecycle();
    await openSocket({ lifecycle, heartbeat });
    controls.wake();
    controls.wake();
    expect(FakeWebSocket.last.sent).toEqual([PING]);
  });

  it('while open without a heartbeat: does nothing', async () => {
    const { lifecycle, controls } = manualLifecycle();
    const { socket } = await openSocket({ lifecycle });
    controls.wake();
    expect(FakeWebSocket.last.sent).toEqual([]);
    expect(socket.state).toBe('open');
  });

  it('while connecting, idle or closed: does nothing', async () => {
    const { lifecycle, controls } = manualLifecycle();
    const { socket } = setup({ lifecycle });
    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    controls.wake();
    expect(FakeWebSocket.instances).toHaveLength(1);
    socket.close();
    controls.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('pause()', () => {
  it('cancels the pending retry and keeps waiting in reconnecting', async () => {
    const { lifecycle, controls } = manualLifecycle();
    const { socket } = await openSocket({ lifecycle });
    FakeWebSocket.last.serverClose();
    controls.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.state).toBe('reconnecting');
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a connection that drops later from scheduling a retry', async () => {
    const { lifecycle, controls } = manualLifecycle();
    const { socket } = await openSocket({ lifecycle });
    controls.pause();
    FakeWebSocket.last.serverClose();
    expect(socket.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not use up reconnect attempts while paused', async () => {
    const { lifecycle, controls } = manualLifecycle();
    const { socket } = await openSocket({
      lifecycle,
      reconnect: { minDelay: 1000, jitter: 'none', maxAttempts: 1 },
    });
    controls.pause();
    FakeWebSocket.last.serverClose();
    controls.wake();
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.last.serverClose();
    // One real attempt was allowed after pausing and it has now failed, so this is attempt 1 of 1.
    expect(socket.state).toBe('reconnecting');
  });

  it('wake() after pause() connects straight away', async () => {
    const { lifecycle, controls } = manualLifecycle();
    const { socket } = await openSocket({ lifecycle });
    controls.pause();
    FakeWebSocket.last.serverClose();
    controls.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('connecting');
    FakeWebSocket.last.open();
    expect(socket.state).toBe('open');
  });

  it('wake() lets later drops retry on the normal backoff again', async () => {
    const { lifecycle, controls } = manualLifecycle();
    await openSocket({ lifecycle });
    controls.pause();
    controls.wake();
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

/** window and document stand-ins built on EventTarget. */
function fakeBrowser() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
  });
  const environment = { window: win, document: doc } as unknown as BrowserEnvironment;
  return {
    environment,
    online: () => win.dispatchEvent(new Event('online')),
    offline: () => win.dispatchEvent(new Event('offline')),
    setVisibility: (state: DocumentVisibilityState) => {
      doc.visibilityState = state;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

describe('browserLifecycle', () => {
  it('offline pauses and online reconnects straight away', async () => {
    const browser = fakeBrowser();
    const { socket } = await openSocket({ lifecycle: browserLifecycle(browser.environment) });
    browser.offline();
    FakeWebSocket.last.serverClose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    browser.online();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('connecting');
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('online while open checks that the connection is alive', async () => {
    const browser = fakeBrowser();
    await openSocket({ lifecycle: browserLifecycle(browser.environment), heartbeat });
    browser.online();
    expect(FakeWebSocket.last.sent).toEqual([PING]);
  });

  it('a tab becoming visible checks health, and a hidden tab does nothing', async () => {
    const browser = fakeBrowser();
    await openSocket({ lifecycle: browserLifecycle(browser.environment), heartbeat });
    browser.setVisibility('hidden');
    expect(FakeWebSocket.last.sent).toEqual([]);
    browser.setVisibility('visible');
    expect(FakeWebSocket.last.sent).toEqual([PING]);
  });

  it('a tab becoming visible while reconnecting skips the backoff wait', async () => {
    const browser = fakeBrowser();
    const { socket } = await openSocket({ lifecycle: browserLifecycle(browser.environment) });
    FakeWebSocket.last.serverClose();
    browser.setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('connecting');
  });

  it('removes its listeners on close()', async () => {
    const browser = fakeBrowser();
    const { socket } = await openSocket({
      lifecycle: browserLifecycle(browser.environment),
      heartbeat,
    });
    socket.close();
    browser.online();
    browser.setVisibility('visible');
    expect(FakeWebSocket.last.sent).toEqual([]);
  });

  it('uses the global window and document by default', () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    const wake = vi.fn();
    const detach = browserLifecycle()({ pause: () => undefined, wake });
    win.dispatchEvent(new Event('online'));
    expect(wake).toHaveBeenCalledTimes(1);
    detach();
    win.dispatchEvent(new Event('online'));
    expect(wake).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('appStateLifecycle', () => {
  function fakeAppState() {
    let listener: (state: string) => void = () => undefined;
    const remove = vi.fn();
    const appState: AppStateLike = {
      addEventListener: (_type, l) => {
        listener = l;
        return { remove };
      },
    };
    return {
      appState,
      change: (state: string) => {
        listener(state);
      },
      remove,
    };
  }

  it('returning to active skips the backoff wait', async () => {
    const { appState, change } = fakeAppState();
    const { socket } = await openSocket({ lifecycle: appStateLifecycle(appState) });
    FakeWebSocket.last.serverClose();
    change('background');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('reconnecting');
    change('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.state).toBe('connecting');
  });

  it('returning to active pings straight away when the socket looks open', async () => {
    const { appState, change } = fakeAppState();
    await openSocket({ lifecycle: appStateLifecycle(appState), heartbeat });
    change('inactive');
    change('background');
    expect(FakeWebSocket.last.sent).toEqual([]);
    change('active');
    expect(FakeWebSocket.last.sent).toEqual([PING]);
  });

  it('removes its subscription on close()', async () => {
    const { appState, remove } = fakeAppState();
    const { socket } = await openSocket({ lifecycle: appStateLifecycle(appState) });
    socket.close();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("accepts the shape of React Native's AppState", () => {
    // What react-native's AppState looks like to us, with the listener's `state` narrowed to its union.
    interface ReactNativeAppState {
      currentState: string;
      addEventListener(
        type: 'change',
        listener: (state: 'active' | 'background' | 'inactive') => void,
      ): { remove(): void };
    }
    const reactNativeAppState: ReactNativeAppState = {
      currentState: 'active',
      addEventListener: () => ({ remove: () => undefined }),
    };
    expect(appStateLifecycle(reactNativeAppState)).toBeTypeOf('function');
  });
});
