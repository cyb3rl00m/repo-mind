import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { checkCustomCommand, detectCommands, redactForLog, type DetectedCommand, type EngineProject, type PreparedCommand, type RunResult, type ToolchainInfo } from '@repomind/core';
import type { EngineConfig } from './config.js';
import { EngineError, forbidden, notFound } from './errors.js';
import { findExecutable, killTree, run, spawn } from './proc.js';
import type { ProjectRegistry } from './projects.js';
import { commandEnv } from './env.js';

interface Pending {
  command: PreparedCommand;
  projectId: string;
  createdAt: number;
}

/**
 * Command execution with an approval binding:
 *  1. `commands.detect` / `commands.prepare` return descriptors, each with a random single-use token
 *     bound to (project, argv, cwd).
 *  2. The UI shows the exact argv, cwd and side-effects; only after the user approves does it call
 *     `commands.run` with that token and `approved: true`.
 *  3. The engine runs exactly the stored argv — no shell, never sudo, with a timeout and output cap.
 */
export class CommandRunner {
  private pending = new Map<string, Pending>();
  private running = new Map<string, { kill: () => void }>();

  constructor(
    private readonly registry: ProjectRegistry,
    private readonly config: EngineConfig
  ) {}

  private token(projectId: string, argv: string[], cwd: string): string {
    return createHash('sha256').update(`${projectId}\0${cwd}\0${argv.join('\0')}\0${randomBytes(16).toString('hex')}`).digest('hex').slice(0, 32);
  }

  private prepare(project: EngineProject, c: DetectedCommand): PreparedCommand {
    const absoluteCwd = c.cwd ? this.registry.resolveInside(project, c.cwd, { mustExist: true }) : project.root;
    const bin = c.argv[0]!;
    let available: boolean;
    if (bin.startsWith('./')) {
      const p = join(absoluteCwd, bin.slice(2));
      try {
        accessSync(p, constants.X_OK);
        available = true;
      } catch {
        available = false;
      }
    } else available = findExecutable(bin, commandEnv(this.config)['PATH']) !== null;
    const token = this.token(project.id, c.argv, absoluteCwd);
    const prepared: PreparedCommand = { ...c, token, absoluteCwd, available };
    this.pending.set(token, { command: prepared, projectId: project.id, createdAt: Date.now() });
    // Tokens expire after 30 minutes.
    for (const [k, v] of this.pending) if (Date.now() - v.createdAt > 30 * 60_000) this.pending.delete(k);
    return prepared;
  }

  detect(project: EngineProject): PreparedCommand[] {
    const root = project.root;
    const probe = {
      exists: (rel: string) => existsSync(join(root, rel)),
      read: (rel: string) => {
        const p = join(root, rel);
        try {
          return statSync(p).isFile() && statSync(p).size < 2_000_000 ? readFileSync(p, 'utf8') : null;
        } catch {
          return null;
        }
      }
    };
    return detectCommands(probe).map((c) => this.prepare(project, c));
  }

  prepareCustom(project: EngineProject, line: string, cwdRel?: string) {
    const safety = checkCustomCommand(line);
    if (!safety.ok) return { command: null, safety };
    const cwd = cwdRel ? cwdRel.replace(/^\.\/?/, '') : '';
    if (cwd) this.registry.resolveInside(project, cwd, { mustExist: true });
    const c: DetectedCommand = {
      id: `custom:${cwd || '.'}:${safety.argv.join(' ')}`,
      label: 'Custom command',
      ecosystem: 'make',
      category: 'check',
      argv: safety.argv,
      cwd,
      description: 'User-entered command. RepoMind cannot predict its side effects.',
      mayDownload: true,
      mayModifyFiles: true,
      requires: safety.argv[0]!,
      timeoutMs: this.config.defaultTimeoutMs
    };
    return { command: this.prepare(project, c), safety };
  }

  async run(
    projectId: string,
    token: string,
    approved: boolean,
    timeoutOverride: number | undefined,
    onOutput: (stream: 'stdout' | 'stderr', text: string) => void,
    onStart?: (runId: string) => void
  ): Promise<RunResult> {
    if (!approved) throw new EngineError('NOT_APPROVED', 'Running a command requires explicit approval in the RepoMind UI.');
    const p = this.pending.get(token);
    if (!p) throw notFound('Unknown or expired command token. Detect or prepare the command again.');
    if (p.projectId !== projectId) throw forbidden('Command token belongs to a different project.');
    this.pending.delete(token); // single use
    const c = p.command;
    const bin = c.argv[0]!;
    if (['sudo', 'su', 'doas', 'pkexec', 'run0'].includes(bin.split('/').pop()!)) throw forbidden('Privileged commands are never executed.');
    const timeoutMs = Math.min(timeoutOverride ?? c.timeoutMs, 2 * 60 * 60_000);
    const env = commandEnv(this.config);
    const runId = randomBytes(8).toString('hex');
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const cap = this.config.maxOutputBytes;

    return new Promise<RunResult>((resolve) => {
      const out = { stdout: new OutputBuffer(cap), stderr: new OutputBuffer(cap) };
      let timedOut = false;
      let cancelled = false;
      const resolvedBin = bin.startsWith('./') ? join(c.absoluteCwd, bin.slice(2)) : bin;
      const child = spawn(resolvedBin, c.argv.slice(1), { cwd: c.absoluteCwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      onStart?.(runId);
      this.running.set(runId, {
        kill: () => {
          cancelled = true;
          killTree(child);
        }
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref();
      }, timeoutMs);
      let pendingOut = '';
      let flushTimer: NodeJS.Timeout | null = null;
      const emit = (stream: 'stdout' | 'stderr', text: string) => {
        out[stream].push(text);
        pendingOut += text;
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            const chunk = pendingOut.slice(-16_000);
            pendingOut = '';
            onOutput(stream, redactForLog(chunk));
          }, 250);
        }
      };
      child.stdout?.setEncoding('utf8').on('data', (d: string) => emit('stdout', d));
      child.stderr?.setEncoding('utf8').on('data', (d: string) => emit('stderr', d));
      const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: string) => {
        clearTimeout(timer);
        if (flushTimer) clearTimeout(flushTimer);
        this.running.delete(runId);
        const stderr = out.stderr.text() + (spawnError ? `\n${spawnError}` : '');
        resolve({
          runId,
          status: timedOut || cancelled || spawnError ? 'inconclusive' : code === 0 ? 'passed' : 'failed',
          exitCode: code,
          signal,
          durationMs: Date.now() - t0,
          timedOut,
          cancelled,
          stdout: redactForLog(out.stdout.text()),
          stderr: redactForLog(stderr),
          truncated: out.stdout.truncated || out.stderr.truncated,
          argv: c.argv,
          cwd: c.absoluteCwd,
          startedAt
        });
      };
      child.on('error', (e) => finish(null, null, `Failed to start ${bin}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'command not found on PATH' : e.message}`));
      child.on('close', (code, signal) => finish(code, signal));
    });
  }

  cancel(runId: string): boolean {
    const r = this.running.get(runId);
    if (!r) return false;
    r.kill();
    return true;
  }

  cancelAll(): void {
    for (const r of this.running.values()) r.kill();
  }

  async toolchains(): Promise<ToolchainInfo[]> {
    const env = commandEnv(this.config);
    const probes: [string, string[], RegExp][] = [
      ['git', ['--version'], /git version (\S+)/],
      ['java', ['-version'], /version "([^"]+)"/],
      ['gradle', ['--version'], /Gradle (\S+)/],
      ['node', ['--version'], /v(\S+)/],
      ['npm', ['--version'], /(\S+)/],
      ['python3', ['--version'], /Python (\S+)/],
      ['cargo', ['--version'], /cargo (\S+)/],
      ['go', ['version'], /go(\d+\.\d+(\.\d+)?)/],
      ['mvn', ['--version'], /Apache Maven (\S+)/],
      ['adb', ['--version'], /version (\S+)/],
      ['make', ['--version'], /Make (\S+)/]
    ];
    const results = await Promise.all(
      probes.map(async ([name, args, re]): Promise<ToolchainInfo> => {
        const path = findExecutable(name, env['PATH']);
        if (!path) return { name, available: false };
        if (name === 'gradle') return { name, available: true, path }; // `gradle --version` can start a daemon; skip.
        const r = await run(path, args, { env, timeoutMs: 8000 });
        const m = re.exec(r.stdout + r.stderr);
        return { name, available: true, path, version: m?.[1] };
      })
    );
    const androidHome = env['ANDROID_HOME'] ?? env['ANDROID_SDK_ROOT'];
    results.push({ name: 'Android SDK', available: Boolean(androidHome && existsSync(androidHome)), path: androidHome });
    return results;
  }
}

/** Keeps the head and the tail of long output (errors are usually at the end). */
class OutputBuffer {
  private head = '';
  private tail = '';
  truncated = false;
  constructor(private readonly cap: number) {}
  push(text: string): void {
    const half = Math.floor(this.cap / 2);
    if (!this.truncated && this.head.length + text.length <= this.cap) {
      this.head += text;
      return;
    }
    if (!this.truncated) {
      this.truncated = true;
      const all = this.head + text;
      this.head = all.slice(0, half);
      this.tail = all.slice(half).slice(-half);
      return;
    }
    this.tail = (this.tail + text).slice(-half);
  }
  text(): string {
    return this.truncated ? `${this.head}\n\n[… output truncated by RepoMind …]\n\n${this.tail}` : this.head;
  }
}
