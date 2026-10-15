import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { Socket } from '../types';

// Typed `unknown` because the context can't know the app's message types. A `Socket<In, Out>` is
// assignable to this (the `Socket` methods are bivariant), and the hooks let callers say what they
// expect back.
const SocketContext = createContext<Socket<unknown, unknown> | null>(null);

export interface SocketProviderProps {
  socket: Socket<unknown, unknown>;
  children?: ReactNode;
}

/**
 * Makes a socket available to the hooks below. It does not connect or close the socket: you create
 * it, call `connect()` and decide when it ends.
 */
export function SocketProvider({ socket, children }: SocketProviderProps) {
  return createElement(SocketContext.Provider, { value: socket }, children);
}

/**
 * The socket from the nearest `SocketProvider`. The type arguments are a claim about the socket you
 * passed to the provider: nothing checks them at runtime.
 */
export function useSocket<Incoming = unknown, Outgoing = unknown>(): Socket<Incoming, Outgoing> {
  const socket = useContext(SocketContext);
  if (!socket) throw new Error('useSocket must be used inside a <SocketProvider>.');
  return socket as Socket<Incoming, Outgoing>;
}
