import type { Lifecycle } from '../types';

/**
 * The part of React Native's `AppState` this adapter uses. You pass the real `AppState` in, so
 * this package never imports `react-native`.
 */
export interface AppStateLike {
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

/**
 * React Native lifecycle: when the app comes back to `active`, skip any backoff wait and connect
 * straight away, or, if the socket looks open, ping it straight away to check it is alive (this
 * needs `heartbeat`). Timers are unreliable in the background and the OS may have dropped the
 * connection, so on return the socket should not wait for its next scheduled attempt.
 */
export function appStateLifecycle(appState: AppStateLike): Lifecycle {
  return ({ wake }) => {
    const subscription = appState.addEventListener('change', (state) => {
      if (state === 'active') wake();
    });
    return () => {
      subscription.remove();
    };
  };
}
