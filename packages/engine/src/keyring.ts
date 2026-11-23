import { findExecutable, run } from './proc.js';

/**
 * GitHub token storage in the operating system keyring through libsecret's `secret-tool`
 * (Secret Service API: GNOME Keyring or KWallet with Secret Service enabled).
 * The token is passed on stdin — never on the command line, never logged, never returned to the UI.
 */
const ATTRS = ['service', 'repomind', 'account', 'github-token'];

export interface KeyringStatus {
  backend: 'secret-tool' | 'none';
  available: boolean;
  detail: string;
}

export async function keyringStatus(): Promise<KeyringStatus> {
  const bin = findExecutable('secret-tool');
  if (!bin) return { backend: 'none', available: false, detail: 'secret-tool not found. Install libsecret (sudo pacman -S libsecret) and a Secret Service provider (GNOME Keyring or KWallet).' };
  const r = await run(bin, ['lookup', ...ATTRS], { timeoutMs: 15_000 });
  // Exit 1 with empty output simply means "not found"; other errors mean no Secret Service.
  if (r.code !== 0 && r.stderr.trim() && !/No such secret/i.test(r.stderr)) {
    return { backend: 'secret-tool', available: false, detail: `Secret Service unavailable: ${r.stderr.trim().slice(0, 200)}` };
  }
  return { backend: 'secret-tool', available: true, detail: 'Using the system keyring via secret-tool.' };
}

export async function getGithubToken(): Promise<string | null> {
  const bin = findExecutable('secret-tool');
  if (!bin) return null;
  const r = await run(bin, ['lookup', ...ATTRS], { timeoutMs: 15_000 });
  const t = r.stdout.trim();
  return r.code === 0 && t ? t : null;
}

export async function setGithubToken(token: string): Promise<void> {
  const bin = findExecutable('secret-tool');
  if (!bin) throw new Error('secret-tool not found');
  const r = await run(bin, ['store', '--label=RepoMind GitHub token (read-only)', ...ATTRS], { input: token, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`Keyring refused to store the token: ${r.stderr.trim().slice(0, 200)}`);
}

export async function deleteGithubToken(): Promise<boolean> {
  const bin = findExecutable('secret-tool');
  if (!bin) return false;
  const r = await run(bin, ['clear', ...ATTRS], { timeoutMs: 15_000 });
  return r.code === 0;
}
