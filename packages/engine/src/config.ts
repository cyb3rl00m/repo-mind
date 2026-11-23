import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { redactForLog } from '@repomind/core';

declare const __ENGINE_VERSION__: string | undefined;
export const ENGINE_VERSION = typeof __ENGINE_VERSION__ === 'string' ? __ENGINE_VERSION__ : '0.1.0-dev';

/** Extension IDs allowed to talk to this host (also enforced by Chrome via the host manifest). */
export const DEFAULT_ALLOWED_ORIGINS = ['chrome-extension://ddblnfbnekcpcpnnbeioffideiikfgmp/'];

function xdg(envName: string, fallback: string): string {
  const v = process.env[envName];
  return v && v.startsWith('/') ? v : join(homedir(), fallback);
}

export const paths = {
  get config(): string {
    return process.env['REPOMIND_CONFIG_DIR'] ?? join(xdg('XDG_CONFIG_HOME', '.config'), 'repomind');
  },
  get state(): string {
    return process.env['REPOMIND_STATE_DIR'] ?? join(xdg('XDG_STATE_HOME', '.local/state'), 'repomind');
  },
  get data(): string {
    return process.env['REPOMIND_DATA_DIR'] ?? join(xdg('XDG_DATA_HOME', '.local/share'), 'repomind');
  },
  get projects(): string {
    return join(this.config, 'projects.json');
  },
  get engineConfig(): string {
    return join(this.config, 'engine.json');
  },
  get log(): string {
    return join(this.state, 'engine.log');
  },
  get worktrees(): string {
    return join(this.data, 'worktrees');
  }
};

export interface EngineConfig {
  /** Extra environment variables for build commands (e.g. ANDROID_HOME, JAVA_HOME). */
  env: Record<string, string>;
  /** Import the login-shell environment so PATH/ANDROID_HOME match a terminal. */
  importShellEnv: boolean;
  /** Additional allowed extension origins (e.g. a Web Store build). */
  allowedOrigins: string[];
  /** Max captured bytes per stream for command output. */
  maxOutputBytes: number;
  defaultTimeoutMs: number;
}

const DEFAULT_CONFIG: EngineConfig = { env: {}, importShellEnv: true, allowedOrigins: [], maxOutputBytes: 2 * 1024 * 1024, defaultTimeoutMs: 20 * 60_000 };

export function loadConfig(): EngineConfig {
  try {
    const raw = JSON.parse(readFileSync(paths.engineConfig, 'utf8')) as Partial<EngineConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      env: typeof raw.env === 'object' && raw.env ? Object.fromEntries(Object.entries(raw.env).filter(([, v]) => typeof v === 'string')) : {},
      allowedOrigins: Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins.filter((o): o is string => typeof o === 'string') : []
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Append-only local log with secret redaction and simple size rotation. Never sent anywhere. */
export function log(level: 'info' | 'warn' | 'error', message: string): void {
  try {
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    try {
      if (statSync(paths.log).size > 2 * 1024 * 1024) renameSync(paths.log, `${paths.log}.1`);
    } catch {
      /* no log yet */
    }
    appendFileSync(paths.log, `${new Date().toISOString()} ${level.toUpperCase()} ${redactForLog(message).slice(0, 4000)}\n`, { mode: 0o600 });
  } catch {
    /* logging must never crash the host */
  }
}
