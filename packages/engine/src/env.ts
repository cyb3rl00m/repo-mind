import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EngineConfig } from './config.js';

let shellEnv: Record<string, string> | null | undefined;

/**
 * Chrome launches native hosts with the browser's environment, which often lacks PATH entries
 * and ANDROID_HOME set in shell rc files. Optionally import the login shell environment once
 * (bash/zsh/fish all support `-l -c`). Values are only used for spawned build commands.
 */
function loginShellEnv(): Record<string, string> | null {
  if (shellEnv !== undefined) return shellEnv;
  shellEnv = null;
  const shell = process.env['SHELL'];
  if (!shell || !/\/(bash|zsh|fish|sh)$/.test(shell)) return shellEnv;
  try {
    const out = execFileSync(shell, ['-l', '-c', 'env -0'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, REPOMIND_ENV_PROBE: '1' } });
    const env: Record<string, string> = {};
    for (const entry of out.split('\0')) {
      const i = entry.indexOf('=');
      if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
    }
    shellEnv = env;
  } catch {
    shellEnv = null;
  }
  return shellEnv;
}

const PASSTHROUGH = /^(PATH|HOME|USER|LOGNAME|LANG|LC_\w+|TERM|TMPDIR|XDG_\w+|JAVA_HOME|ANDROID_HOME|ANDROID_SDK_ROOT|ANDROID_NDK_HOME|GRADLE_USER_HOME|GRADLE_OPTS|JAVA_TOOL_OPTIONS|MAVEN_OPTS|NODE_OPTIONS|NVM_\w+|VOLTA_HOME|PNPM_HOME|BUN_INSTALL|CARGO_HOME|RUSTUP_HOME|GOPATH|GOROOT|GOCACHE|GOFLAGS|PYENV_ROOT|VIRTUAL_ENV|CONDA_\w+|PYTHONPATH|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|DISPLAY|WAYLAND_DISPLAY|SHELL|CI)$/;

/** Environment for build/test commands: allow-listed variables only, so tokens in the browser env do not leak. */
export function commandEnv(config: EngineConfig): NodeJS.ProcessEnv {
  const base: Record<string, string> = {};
  const sources = [process.env as Record<string, string>, config.importShellEnv ? loginShellEnv() ?? {} : {}];
  for (const src of sources) for (const [k, v] of Object.entries(src)) if (PASSTHROUGH.test(k) && typeof v === 'string') base[k] = v;
  const extraPath = [join(homedir(), '.local/bin'), join(homedir(), '.cargo/bin'), join(homedir(), 'go/bin'), '/usr/local/bin', '/usr/bin', '/bin'];
  const path = new Set([...(base['PATH'] ?? '').split(':').filter(Boolean), ...extraPath]);
  if (base['ANDROID_HOME']) path.add(join(base['ANDROID_HOME'], 'platform-tools'));
  base['PATH'] = [...path].join(':');
  return { ...base, ...config.env, CI: config.env['CI'] ?? 'true', TERM: 'dumb', GRADLE_OPTS: base['GRADLE_OPTS'] ?? '', NO_COLOR: '1' };
}
