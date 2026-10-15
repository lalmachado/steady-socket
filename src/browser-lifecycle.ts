import type { Lifecycle } from './types';

/** The few parts of `window` and `document` the adapter uses, so tests can pass fakes. */
export interface BrowserEnvironment {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

/**
 * Web lifecycle: `online` connects now, `offline` pauses reconnecting, and a tab becoming visible
 * again checks that the connection is still alive. Pass `environment` to use something other than
 * the global `window` and `document`.
 */
export function browserLifecycle(environment?: BrowserEnvironment): Lifecycle {
  return ({ pause, wake }) => {
    const { window, document } = environment ?? {
      window: globalThis.window,
      document: globalThis.document,
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') wake();
    };
    window.addEventListener('online', wake);
    window.addEventListener('offline', pause);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', pause);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  };
}
