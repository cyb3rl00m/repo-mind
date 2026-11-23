import { existsSync, readFileSync, statSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import {
  GitHubClient,
  PROTOCOL_VERSION,
  filesFromZip,
  type EngineMethod,
  type EngineMethods,
  type FetchLike,
  type IngestOptions
} from '@repomind/core';
import { CommandRunner } from './commands.js';
import { ENGINE_VERSION, loadConfig, paths, type EngineConfig } from './config.js';
import { pickFolder } from './dialog.js';
import { EngineError, bad, bool, forbidden, notApproved, obj, optNum, optStr, str, strArray, unavailable } from './errors.js';
import { git, gitInfo, gitTopLevel, isGitRepo, listCheckpoints } from './git.js';
import { deleteGithubToken, getGithubToken, keyringStatus, setGithubToken } from './keyring.js';
import { applyPatch, checkPatch, revertPatch } from './patch.js';
import { findExecutable } from './proc.js';
import { ProjectRegistry, isInside } from './projects.js';
import { scanProject } from './scan.js';

export interface HandlerContext {
  progress(data: { message?: string; done?: number; total?: number }): void;
  output(stream: 'stdout' | 'stderr', text: string): void;
}

type Handler<M extends EngineMethod> = (params: Record<string, unknown>, ctx: HandlerContext) => Promise<EngineMethods[M]['result']>;
type HandlerMap = { [M in EngineMethod]: Handler<M> };

function ingestOptions(v: unknown): IngestOptions {
  if (v === undefined) return {};
  const o = obj(v, 'options');
  const out: IngestOptions = {};
  if (o['extraExclusions'] !== undefined) out.extraExclusions = strArray(o, 'extraExclusions', 500);
  if (o['respectGitignore'] !== undefined) out.respectGitignore = bool(o, 'respectGitignore');
  if (o['useDefaultExclusions'] !== undefined) out.useDefaultExclusions = bool(o, 'useDefaultExclusions');
  const mfb = optNum(o, 'maxFileBytes', 1024, 16 * 1024 * 1024);
  if (mfb) out.maxFileBytes = mfb;
  const mf = optNum(o, 'maxFiles', 1, 200_000);
  if (mf) out.maxFiles = mf;
  if (o['includeSecretFiles'] === true) throw forbidden('Including secret files in an index is not allowed from the extension.');
  return out;
}

const WORKTREE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function createHandlers(registry = new ProjectRegistry(), config: EngineConfig = loadConfig(), fetchImpl: FetchLike = fetch as unknown as FetchLike): { handlers: HandlerMap; runner: CommandRunner } {
  const runner = new CommandRunner(registry, config);
  const project = (p: Record<string, unknown>) => registry.get(str(p, 'projectId', { max: 64 }));

  const handlers: HandlerMap = {
    'engine.hello': async (p) => {
      const protocol = p['protocol'];
      if (protocol !== PROTOCOL_VERSION) throw new EngineError('PROTOCOL', `Protocol mismatch: extension speaks v${String(protocol)}, engine speaks v${PROTOCOL_VERSION}. Update both to the same RepoMind release.`);
      const ks = await keyringStatus();
      return {
        engineVersion: ENGINE_VERSION,
        protocol: PROTOCOL_VERSION,
        platform: platform(),
        arch: arch(),
        node: process.versions.node,
        capabilities: {
          git: findExecutable('git') !== null,
          keyring: ks.available,
          folderPicker: findExecutable('kdialog') !== null || findExecutable('zenity') !== null,
          worktrees: true,
          commands: true
        },
        configPath: paths.engineConfig,
        logPath: paths.log
      };
    },

    'project.pickFolder': async (p) => pickFolder(optStr(p, 'title', 200)),

    'project.register': async (p) => {
      const path = str(p, 'path', { max: 4096 });
      const proj = registry.register(path);
      // Prefer the git top-level when the user picked a sub-folder? No: respect the explicit choice,
      // but report git status for the chosen folder.
      return { ...proj, isGit: (await gitTopLevel(proj.root)) !== null };
    },

    'project.list': async () => ({ projects: registry.list() }),

    'project.forget': async (p) => ({ removed: registry.forget(str(p, 'projectId', { max: 64 })) }),

    'project.scan': async (p, ctx) => {
      const proj = project(p);
      const t0 = Date.now();
      ctx.progress({ message: `Scanning ${proj.root}` });
      const r = scanProject(proj.root, ingestOptions(p['options']), (n) => ctx.progress({ message: `Scanned ${n} files`, done: n }));
      ctx.progress({ message: `Read ${r.files.length} files (${r.skipped.length} skipped)` });
      return { files: r.files, skipped: r.skipped, root: proj.root, durationMs: Date.now() - t0 };
    },

    'project.readFiles': async (p) => {
      const proj = project(p);
      const list = strArray(p, 'paths', 2000);
      return {
        files: list.map((rel) => {
          try {
            const abs = registry.resolveInside(proj, rel);
            if (!existsSync(abs)) return { path: rel, content: null };
            if (statSync(abs).size > 4 * 1024 * 1024) return { path: rel, content: null, error: 'File larger than 4 MiB' };
            return { path: rel, content: readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') };
          } catch (e) {
            return { path: rel, content: null, error: (e as Error).message };
          }
        })
      };
    },

    'git.info': async (p) => gitInfo(project(p).root),

    'git.diff': async (p) => {
      const proj = project(p);
      if (!(await isGitRepo(proj.root))) throw bad('Not a git repository');
      const rels = p['paths'] === undefined ? [] : strArray(p, 'paths', 500).map((r) => {
        registry.resolveInside(proj, r);
        return r;
      });
      const r = await git(proj.root, ['diff', 'HEAD', '--no-ext-diff', '--', ...rels]);
      return { diff: r.stdout };
    },

    'patch.check': async (p) => {
      const proj = project(p);
      const r = await checkPatch(registry, proj, str(p, 'diff', { max: 16 * 1024 * 1024 }), { allowDeletes: bool(p, 'allowDeletes'), allowSecretFiles: bool(p, 'allowSecretFiles') });
      return { ok: r.ok, issues: r.issues, gitCheck: r.gitCheck, dirtyOverlap: r.dirtyOverlap, files: r.files };
    },

    'patch.apply': async (p) => {
      if (!bool(p, 'approved')) throw notApproved('Applying a patch');
      return applyPatch(registry, project(p), str(p, 'diff', { max: 16 * 1024 * 1024 }), {
        allowDeletes: bool(p, 'allowDeletes'),
        allowDirtyOverlap: bool(p, 'allowDirtyOverlap'),
        allowSecretFiles: bool(p, 'allowSecretFiles')
      });
    },

    'patch.revert': async (p) => {
      if (!bool(p, 'approved')) throw notApproved('Reverting a patch');
      return revertPatch(project(p), str(p, 'diff', { max: 16 * 1024 * 1024 }));
    },

    'checkpoint.list': async (p) => ({ checkpoints: await listCheckpoints(project(p).root) }),

    'worktree.create': async (p) => {
      if (!bool(p, 'approved')) throw notApproved('Creating a worktree');
      const proj = project(p);
      const name = str(p, 'name', { max: 40 });
      if (!WORKTREE_NAME.test(name)) throw bad('Worktree name must be lowercase letters, digits and dashes (max 40).');
      const top = await gitTopLevel(proj.root);
      if (!top) throw bad('Worktrees require a git repository.');
      const path = join(paths.worktrees, proj.id, name);
      if (existsSync(path)) throw new EngineError('CONFLICT', `Worktree path already exists: ${path}`);
      const branch = `repomind/${name}`;
      const r = await git(top, ['worktree', 'add', '-b', branch, path, 'HEAD']);
      if (r.code !== 0) throw new EngineError('CONFLICT', `git worktree add failed: ${r.stderr.trim()}`);
      const wt = registry.register(path, { worktreeOf: proj.id });
      return { project: { ...wt, isGit: true }, branch, path };
    },

    'worktree.list': async (p) => {
      const proj = project(p);
      const r = await git(proj.root, ['worktree', 'list', '--porcelain']);
      if (r.code !== 0) return { worktrees: [] };
      const out: { path: string; branch: string | null; head: string; managed: boolean }[] = [];
      let cur: { path: string; branch: string | null; head: string } | null = null;
      for (const line of r.stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (cur) out.push({ ...cur, managed: isInside(paths.worktrees, cur.path) });
          cur = { path: line.slice(9), branch: null, head: '' };
        } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
        else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
      }
      if (cur) out.push({ ...cur, managed: isInside(paths.worktrees, cur.path) });
      return { worktrees: out };
    },

    'worktree.remove': async (p) => {
      if (!bool(p, 'approved')) throw notApproved('Removing a worktree');
      const proj = project(p);
      const path = str(p, 'path', { max: 4096 });
      if (!isInside(paths.worktrees, path) || path === paths.worktrees) throw forbidden('Only worktrees created by RepoMind can be removed from RepoMind.');
      const r = await git(proj.root, ['worktree', 'remove', path]);
      if (r.code === 0) {
        const wt = registry.list().find((x) => x.root === path);
        if (wt) registry.forget(wt.id);
      }
      return { removed: r.code === 0, output: (r.stdout + r.stderr).trim() || (r.code === 0 ? 'Removed. The branch was kept.' : 'Failed') };
    },

    'commands.detect': async (p) => {
      const proj = project(p);
      const [commands, toolchains] = [runner.detect(proj), await runner.toolchains()];
      return { commands, toolchains };
    },

    'commands.prepare': async (p) => runner.prepareCustom(project(p), str(p, 'commandLine', { max: 2000 }), optStr(p, 'cwd', 1024)),

    'commands.run': async (p, ctx) => {
      const proj = project(p);
      return runner.run(proj.id, str(p, 'token', { max: 64 }), bool(p, 'approved'), optNum(p, 'timeoutMs', 1000, 2 * 60 * 60_000), (stream, text) => ctx.output(stream, text), (runId) => ctx.progress({ message: `run-started:${runId}` }));
    },

    'commands.cancel': async (p) => ({ cancelled: runner.cancel(str(p, 'runId', { max: 64 })) }),

    'secrets.status': async () => {
      const s = await keyringStatus();
      return { ...s, hasGithubToken: s.available ? (await getGithubToken()) !== null : false };
    },

    'secrets.setGithubToken': async (p) => {
      const token = str(p, 'token', { max: 400 }).trim();
      if (!/^(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})$/.test(token)) throw bad('That does not look like a GitHub token (expected github_pat_… or ghp_…).');
      const ks = await keyringStatus();
      if (!ks.available) throw unavailable(ks.detail);
      let info: { login: string; scopes: string[] | null; classic: boolean } | null = null;
      try {
        info = await new GitHubClient(fetchImpl, token).tokenInfo();
      } catch (e) {
        if ((e as { status?: number }).status === 401) throw bad('GitHub rejected this token (invalid, expired or revoked).');
      }
      await setGithubToken(token);
      let warning: string | null = null;
      if (info?.classic) warning = `This is a classic token${info.scopes?.length ? ` with scopes: ${info.scopes.join(', ')}` : ''}. RepoMind only needs read access — a fine-grained token with “Contents: Read-only” and “Metadata: Read-only” on selected repositories is safer.`;
      return { stored: true, login: info?.login ?? null, classic: info?.classic ?? false, scopes: info?.scopes ?? null, warning };
    },

    'secrets.deleteGithubToken': async () => ({ deleted: await deleteGithubToken() }),

    'github.fetch': async (p, ctx) => {
      const owner = str(p, 'owner', { max: 100 });
      const repo = str(p, 'repo', { max: 100 });
      if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) throw bad('Invalid owner/repo');
      let token: string | undefined;
      if (bool(p, 'useToken')) {
        token = (await getGithubToken()) ?? undefined;
        if (!token) throw unavailable('No GitHub token stored in the keyring. Add one in Settings → GitHub.');
      }
      const gh = new GitHubClient(fetchImpl, token);
      ctx.progress({ message: 'Fetching repository metadata' });
      const meta = await gh.repo(owner, repo);
      const branches = await gh.branches(owner, repo).catch(() => []);
      const ref = optStr(p, 'ref', 255) ?? meta.defaultBranch;
      const commit = await gh.commitSha(owner, repo, ref);
      ctx.progress({ message: `Downloading snapshot ${commit.sha.slice(0, 10)}` });
      const zip = await gh.zipball(owner, repo, commit.sha);
      ctx.progress({ message: `Extracting ${(zip.byteLength / 1e6).toFixed(1)} MB archive` });
      const subPath = optStr(p, 'subPath', 1024);
      const r = filesFromZip(zip, { ...ingestOptions(p['options']), subPath });
      return { meta, branches, ref, commit, files: r.files, skipped: r.skipped };
    }
  };
  return { handlers, runner };
}
