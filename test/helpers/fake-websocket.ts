import type { WebSocketLike } from '../../src/types';

type Listener = (event: never) => void;

/** A WebSocket the test drives by hand: nothing opens, closes or arrives until the test says so. */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static get last(): FakeWebSocket {
    const instance = FakeWebSocket.instances.at(-1);
    if (!instance) throw new Error('No FakeWebSocket has been created yet.');
    return instance;
  }
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readonly sent: string[] = [];
  closeCalls: { code: number | undefined; reason: string | undefined }[] = [];
  silent = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  /** Called by the code under test. */
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  /** The server accepts the connection. */
  open(): void {
    this.emit('open', {});
  }
  /** The server (or the network) closes the connection. */
  serverClose(code = 1006, reason = ''): void {
    this.emit('close', { code, reason });
  }
  /** The server sends a message. Ignored once the socket has gone silent. */
  receive(data: string): void {
    if (!this.silent) this.emit('message', { data });
  }
  /** The connection stays "open" but nothing more is delivered. No `close` event ever fires. */
  goSilent(): void {
    this.silent = true;
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? [])
      (listener as (e: unknown) => void)(event);
  }
}
