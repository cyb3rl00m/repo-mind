import {
  ChunkAssembler,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  type EngineMethod,
  type EngineMethods,
  type EventEnvelope,
  type HostMessage,
  type ResponseEnvelope
} from '@repomind/core';

export type EngineState =
  | { status: 'disconnected'; error?: string }
  | { status: 'connecting' }
  | { status: 'connected'; info: EngineMethods['engine.hello']['result'] };

export class EngineCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  onEvent?: (e: EventEnvelope) => void;
}

/**
 * Native Messaging client. One long-lived port; requests are multiplexed by id; large responses
 * arrive as base64 chunks and are reassembled here.
 */
class EngineClient {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<string, Pending>();
  private asm = new ChunkAssembler();
  private seq = 0;
  private listeners = new Set<(s: EngineState) => void>();
  state: EngineState = { status: 'disconnected' };

  subscribe(fn: (s: EngineState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(s: EngineState) {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  get available(): boolean {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.connectNative);
  }

  async connect(): Promise<EngineState> {
    if (this.state.status === 'connected' && this.port) return this.state;
    if (!this.available) {
      this.set({ status: 'disconnected', error: 'Native Messaging is unavailable in this context.' });
      return this.state;
    }
    this.set({ status: 'connecting' });
    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      this.port = port;
      port.onMessage.addListener((m: HostMessage) => this.onMessage(m));
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message ?? 'The local engine disconnected.';
        this.port = null;
        for (const p of this.pending.values()) p.reject(new EngineCallError('DISCONNECTED', err));
        this.pending.clear();
        this.set({ status: 'disconnected', error: explainDisconnect(err) });
      });
      const info = await this.call('engine.hello', { client: `repomind-extension/${chrome.runtime.getManifest().version}`, protocol: PROTOCOL_VERSION }, { timeoutMs: 15000 });
      this.set({ status: 'connected', info });
    } catch (e) {
      this.port?.disconnect();
      this.port = null;
      if (this.state.status !== 'disconnected') this.set({ status: 'disconnected', error: explainDisconnect((e as Error).message) });
    }
    return this.state;
  }

  disconnect(): void {
    this.port?.disconnect();
    this.port = null;
    this.set({ status: 'disconnected' });
  }

  private onMessage(m: HostMessage) {
    if ('chunk' in m) {
      try {
        const done = this.asm.push(m);
        const p = this.pending.get(m.id);
        p?.onEvent?.({ v: 1, id: m.id, event: 'progress', data: { message: 'Receiving data', done: m.chunk.seq + 1, total: m.chunk.total } });
        if (done) this.finish(done);
      } catch (e) {
        this.pending.get(m.id)?.reject(e as Error);
        this.pending.delete(m.id);
      }
      return;
    }
    if ('event' in m) {
      this.pending.get(m.id)?.onEvent?.(m);
      return;
    }
    this.finish(m);
  }

  private finish(r: ResponseEnvelope) {
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    if (r.ok) p.resolve(r.result);
    else p.reject(new EngineCallError(r.error.code, r.error.message, r.error.details));
  }

  call<M extends EngineMethod>(
    method: M,
    params: EngineMethods[M]['params'],
    opts: { onEvent?: (e: EventEnvelope) => void; timeoutMs?: number } = {}
  ): Promise<EngineMethods[M]['result']> {
    const port = this.port;
    if (!port) return Promise.reject(new EngineCallError('DISCONNECTED', 'Local engine is not connected.'));
    const id = `r${++this.seq}_${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (fn: () => void) => {
        if (timer) clearTimeout(timer);
        fn();
      };
      this.pending.set(id, {
        resolve: (v) => done(() => resolve(v as EngineMethods[M]['result'])),
        reject: (e) => done(() => reject(e)),
        onEvent: opts.onEvent
      });
      if (opts.timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          this.asm.drop(id);
          reject(new EngineCallError('TIMEOUT', `${method} timed out`));
        }, opts.timeoutMs);
      }
      try {
        port.postMessage({ v: PROTOCOL_VERSION, id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(new EngineCallError('DISCONNECTED', (e as Error).message));
      }
    });
  }
}

function explainDisconnect(msg: string): string {
  if (/not found/i.test(msg)) return 'Local engine is not installed or not registered for this browser. Run scripts/install.sh, then reconnect.';
  if (/forbidden/i.test(msg)) return 'The engine host manifest does not allow this extension ID. Re-run scripts/install.sh.';
  if (/exited/i.test(msg)) return 'The local engine exited. Run `repomind-engine --doctor` in a terminal and check ~/.local/state/repomind/engine.log.';
  return msg;
}

export const engine = new EngineClient();
