import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { accessSync, constants } from 'node:fs';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a binary with argv (never through a shell). */
export function run(bin: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, env: opts.env ?? process.env, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : e.code === 'ENOENT' ? 127 : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') + (e && e.code === 'ENOENT' ? `${bin}: not found` : ''),
          timedOut: Boolean(e?.killed && e.signal === 'SIGTERM')
        });
      }
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    } else child.stdin?.end();
  });
}

/** Locates an executable on PATH (no shell, no `which` dependency). */
export function findExecutable(name: string, envPath = process.env['PATH'] ?? ''): string | null {
  if (name.includes('/')) {
    try {
      accessSync(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const dir of envPath.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* continue */
    }
  }
  return null;
}

/** Kills a detached child and its whole process group (Gradle daemons spawned by it are left alone). */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export { spawn };
