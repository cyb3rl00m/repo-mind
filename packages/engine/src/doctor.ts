import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_HOST_NAME, PROTOCOL_VERSION } from '@repomind/core';
import { DEFAULT_ALLOWED_ORIGINS, ENGINE_VERSION, loadConfig, paths } from './config.js';
import { commandEnv } from './env.js';
import { keyringStatus } from './keyring.js';
import { findExecutable, run } from './proc.js';

export const BROWSER_HOST_DIRS: Record<string, string> = {
  'Google Chrome': '.config/google-chrome/NativeMessagingHosts',
  'Google Chrome Beta': '.config/google-chrome-beta/NativeMessagingHosts',
  'Google Chrome Dev': '.config/google-chrome-unstable/NativeMessagingHosts',
  Chromium: '.config/chromium/NativeMessagingHosts',
  Brave: '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
  Vivaldi: '.config/vivaldi/NativeMessagingHosts',
  'Microsoft Edge': '.config/microsoft-edge/NativeMessagingHosts'
};

/** Installation self-check printed by `repomind-engine --doctor`. Returns a process exit code. */
export async function runDoctor(): Promise<number> {
  let failures = 0;
  const ok = (m: string) => process.stdout.write(`  ✔ ${m}\n`);
  const warn = (m: string) => process.stdout.write(`  ! ${m}\n`);
  const fail = (m: string) => {
    failures++;
    process.stdout.write(`  ✘ ${m}\n`);
  };
  process.stdout.write(`RepoMind engine ${ENGINE_VERSION} — protocol v${PROTOCOL_VERSION}\n\nRuntime\n`);
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node} is too old (need >= 20)`);
  const gitBin = findExecutable('git');
  if (gitBin) ok(`git: ${(await run(gitBin, ['--version'])).stdout.trim()}`);
  else fail('git not found (sudo pacman -S git)');

  process.stdout.write('\nNative Messaging registration\n');
  let registered = 0;
  for (const [browser, dir] of Object.entries(BROWSER_HOST_DIRS)) {
    const file = join(homedir(), dir, `${NATIVE_HOST_NAME}.json`);
    if (!existsSync(file)) continue;
    registered++;
    try {
      const m = JSON.parse(readFileSync(file, 'utf8')) as { path?: string; allowed_origins?: string[]; type?: string };
      const problems: string[] = [];
      if (m.type !== 'stdio') problems.push('type must be "stdio"');
      if (!m.path || !existsSync(m.path)) problems.push(`host path missing: ${m.path}`);
      if (!m.allowed_origins?.some((o) => DEFAULT_ALLOWED_ORIGINS.includes(o) || loadConfig().allowedOrigins.includes(o))) problems.push('allowed_origins does not contain the RepoMind extension ID');
      if (problems.length) fail(`${browser}: ${file} — ${problems.join('; ')}`);
      else ok(`${browser}: ${file}`);
    } catch {
      fail(`${browser}: ${file} is not valid JSON`);
    }
  }
  if (registered === 0) fail('No browser has the host manifest. Run scripts/install.sh.');

  process.stdout.write('\nOptional features\n');
  const ks = await keyringStatus();
  if (ks.available) ok(`Keyring: ${ks.detail}`);
  else warn(`Keyring: ${ks.detail} (private-repo tokens will only be kept in browser session memory)`);
  if (findExecutable('kdialog')) ok('Folder picker: kdialog');
  else if (findExecutable('zenity')) ok('Folder picker: zenity');
  else warn('No folder picker (install kdialog or zenity); you can still type folder paths.');

  process.stdout.write('\nBuild toolchains (as seen by build commands)\n');
  const env = commandEnv(loadConfig());
  for (const t of ['java', 'node', 'npm', 'python3', 'cargo', 'go', 'adb']) {
    const p = findExecutable(t, env['PATH']);
    if (p) ok(`${t}: ${p}`);
    else warn(`${t}: not found`);
  }
  const androidHome = env['ANDROID_HOME'] ?? env['ANDROID_SDK_ROOT'];
  if (androidHome && existsSync(androidHome)) ok(`Android SDK: ${androidHome}`);
  else warn('ANDROID_HOME / ANDROID_SDK_ROOT not set — Gradle Android builds need it (or sdk.dir in local.properties).');

  process.stdout.write(`\nFiles\n  config: ${paths.config}\n  log:    ${paths.log}\n  worktrees: ${paths.worktrees}\n\n`);
  process.stdout.write(failures ? `${failures} problem(s) found.\n` : 'All required checks passed.\n');
  return failures ? 1 : 0;
}
