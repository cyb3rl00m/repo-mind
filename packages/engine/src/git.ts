import type { GitInfo } from '@repomind/core';
import { run, type ExecResult } from './proc.js';

const GIT_ENV = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
  // Never let a repository's config hooks open an editor or pager.
  GIT_EDITOR: 'true',
  GIT_PAGER: 'cat'
});

export function git(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  return run('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], { cwd, env: GIT_ENV(), timeoutMs: opts.timeoutMs ?? 60_000, input: opts.input });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function gitTopLevel(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  if (!(await isGitRepo(cwd))) {
    return { isGit: false, branch: null, head: null, headMessage: null, upstream: null, ahead: 0, behind: 0, dirty: [], remotes: [] };
  }
  const [status, log, remotes] = await Promise.all([
    git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
    git(cwd, ['log', '-1', '--format=%H%x00%s']),
    git(cwd, ['remote', '-v'])
  ]);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let head: string | null = null;
  const dirty: { path: string; status: string }[] = [];
  for (const line of status.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
    else if (line.startsWith('# branch.oid ')) head = line.slice(13).trim();
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ');
      const xy = parts[1]!;
      const path = line.startsWith('2 ') ? parts.slice(9).join(' ').split('\t')[0]! : parts.slice(8).join(' ');
      dirty.push({ path, status: xy });
    } else if (line.startsWith('? ')) dirty.push({ path: line.slice(2), status: '??' });
    else if (line.startsWith('u ')) dirty.push({ path: line.split(' ').slice(10).join(' '), status: 'UU' });
  }
  if (branch === '(detached)') branch = null;
  if (head === '(initial)') head = null;
  const [sha, msg] = log.code === 0 ? log.stdout.trim().split('\0') : [null, null];
  const remoteList: { name: string; url: string }[] = [];
  for (const line of remotes.stdout.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
    // Strip credentials embedded in remote URLs before they leave the engine.
    if (m) remoteList.push({ name: m[1]!, url: m[2]!.replace(/\/\/[^@/]+@/, '//') });
  }
  return { isGit: true, branch, head: sha ?? head, headMessage: msg ?? null, upstream, ahead, behind, dirty, remotes: remoteList };
}

/**
 * Creates a checkpoint of the current working tree WITHOUT modifying it: `git stash create`
 * builds a commit object for tracked changes, which is then pinned under refs/repomind/.
 * Untracked files are not part of the checkpoint (git apply never overwrites them).
 */
export async function createCheckpoint(cwd: string, label: string): Promise<string | null> {
  const stash = await git(cwd, ['stash', 'create', `repomind: ${label}`]);
  let sha = stash.stdout.trim();
  if (stash.code !== 0) return null;
  if (!sha) {
    const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
    if (head.code !== 0) return null;
    sha = head.stdout.trim();
  }
  const ref = `refs/repomind/checkpoints/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const r = await git(cwd, ['update-ref', '-m', `repomind checkpoint: ${label}`, ref, sha]);
  return r.code === 0 ? sha : null;
}

export async function listCheckpoints(cwd: string): Promise<{ ref: string; sha: string; date: string; subject: string }[]> {
  const r = await git(cwd, ['for-each-ref', '--sort=-refname', '--format=%(refname)%00%(objectname)%00%(creatordate:iso-strict)%00%(subject)', 'refs/repomind/checkpoints/']);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, sha, date, subject] = l.split('\0');
      return { ref: ref!, sha: sha!, date: date!, subject: subject ?? '' };
    });
}
