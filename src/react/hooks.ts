import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useSocket } from './context';
import type { ConnectionState } from '../types';

/** The socket's connection state. Re-renders only when the state changes. */
export function useSocketState(): ConnectionState {
  const socket = useSocket();
  return useSyncExternalStore(
    // `onState` returns its own unsubscribe function, which is what React expects back.
    (onStoreChange) => socket.onState(onStoreChange),
    () => socket.state,
    // Server rendering has no connection yet.
    () => 'idle',
  );
}

/**
 * Listens to a topic while the component is mounted. Passing a new `handler` on every render is
 * fine: it does not resubscribe, and the latest one is always the one called. The topic is
 * subscribed again only when `topic` (or the socket) changes.
 *
 * `Incoming` is the same kind of claim as in `useSocket`.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the socket's message type is erased by the context, so the caller restates it.
export function useSubscription<Incoming = unknown>(
  topic: string,
  handler: (message: Incoming) => void,
): void {
  const socket = useSocket();
  const latest = useRef(handler);

  // Declared before the subscribing effect so the ref is current by the time messages can arrive.
  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => {
    return socket.subscribe(topic, (message) => {
      latest.current(message as Incoming);
    });
  }, [socket, topic]);
}
