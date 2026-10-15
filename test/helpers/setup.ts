import { createSocket } from '../../src';
import type { ConnectionState, SocketOptions } from '../../src';
import { FakeWebSocket } from './fake-websocket';

export type Msg = { type: string };

export function setup(overrides: Partial<SocketOptions<Msg, Msg>> = {}) {
  const socket = createSocket<Msg, Msg>({
    url: 'wss://example.test/ws',
    WebSocket: FakeWebSocket,
    reconnect: { minDelay: 1000, maxDelay: 8000, factor: 2, jitter: 'none' },
    ...overrides,
  });
  const states: ConnectionState[] = [];
  socket.onState((s) => states.push(s));
  return { socket, states };
}
