import { PROTOCOL_VERSION, encodeHostResponse, type EngineMethod, type EventEnvelope, type ResponseEnvelope } from '@repomind/core';
import { DEFAULT_ALLOWED_ORIGINS, ENGINE_VERSION, loadConfig, log, paths } from './config.js';
import { EngineError } from './errors.js';
import { createHandlers } from './handlers.js';
import { NativeMessagingIO } from './nm.js';
import { runDoctor } from './doctor.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write(`repomind-engine ${ENGINE_VERSION} (protocol v${PROTOCOL_VERSION})\n`);
    return;
  }
  if (args.includes('--doctor')) {
    process.exitCode = await runDoctor();
    return;
  }

  // Chrome passes the calling extension origin as the first argument on Linux/macOS.
  const config = loadConfig();
  const origin = args.find((a) => a.startsWith('chrome-extension://'));
  const allowed = [...DEFAULT_ALLOWED_ORIGINS, ...config.allowedOrigins];
  if (origin && !allowed.includes(origin)) {
    log('warn', `Rejected connection from unexpected origin ${origin}`);
    process.exitCode = 2;
    return;
  }
  if (!origin && process.stdin.isTTY) {
    process.stderr.write(
      'repomind-engine is a Chrome Native Messaging host and is started by the RepoMind extension.\n' +
        'Run with --doctor to check the installation, or --version.\n'
    );
    process.exitCode = 1;
    return;
  }

  const { handlers, runner } = createHandlers(undefined, config);
  log('info', `Engine ${ENGINE_VERSION} started for ${origin ?? 'unknown origin'} (config ${paths.config})`);

  const io: NativeMessagingIO = new NativeMessagingIO(
    process.stdin,
    process.stdout,
    (raw) => void handle(raw),
    (err) => log('error', `I/O: ${err.message}`),
    () => {
      runner.cancelAll();
      log('info', 'Extension disconnected; exiting.');
      setTimeout(() => process.exit(0), 50).unref();
    }
  );

  async function send(resp: ResponseEnvelope): Promise<void> {
    for (const msg of encodeHostResponse(resp)) await io.send(msg);
  }

  async function handle(raw: unknown): Promise<void> {
    const req = raw as { v?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const id = typeof req?.id === 'string' && req.id.length <= 64 ? req.id : 'invalid';
    if (req?.v !== PROTOCOL_VERSION) {
      await send({ v: PROTOCOL_VERSION, id, ok: false, error: { code: 'PROTOCOL', message: `Unsupported protocol version ${String(req?.v)}; expected ${PROTOCOL_VERSION}.` } });
      return;
    }
    const method = req.method;
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, method)) {
      await send({ v: PROTOCOL_VERSION, id, ok: false, error: { code: 'UNKNOWN_METHOD', message: `Unknown method ${String(method)}` } });
      return;
    }
    const params = req.params === undefined ? {} : req.params;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      await send({ v: PROTOCOL_VERSION, id, ok: false, error: { code: 'BAD_REQUEST', message: 'params must be an object' } });
      return;
    }
    const event = (e: Omit<EventEnvelope, 'v' | 'id'>) => void io.send({ v: PROTOCOL_VERSION, id, ...e });
    const ctx = {
      progress: (data: { message?: string; done?: number; total?: number }) => event({ event: 'progress', data }),
      output: (stream: 'stdout' | 'stderr', text: string) => event({ event: 'output', data: { stream, text } })
    };
    const t0 = Date.now();
    try {
      const handler = handlers[method as EngineMethod] as (p: Record<string, unknown>, c: typeof ctx) => Promise<unknown>;
      const result = await handler(params as Record<string, unknown>, ctx);
      await send({ v: PROTOCOL_VERSION, id, ok: true, result } as ResponseEnvelope);
      log('info', `${method} ok in ${Date.now() - t0} ms`);
    } catch (e) {
      const err = e instanceof EngineError ? e : new EngineError('INTERNAL', (e as Error)?.message ?? String(e));
      log(err.code === 'INTERNAL' ? 'error' : 'warn', `${method} failed: ${err.code} ${err.message}`);
      await send({ v: PROTOCOL_VERSION, id, ok: false, error: { code: err.code, message: err.message, details: err.details } });
    }
  }
}

process.on('uncaughtException', (e) => log('error', `uncaught: ${e.stack ?? e.message}`));
process.on('unhandledRejection', (e) => log('error', `unhandled: ${String(e)}`));
void main();
