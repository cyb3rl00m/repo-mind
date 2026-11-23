import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyFilePatch, formatUnifiedDiff, parseUnifiedDiff, validatePatchPaths, type EngineMethods, type EngineProject, type PatchIssue } from '@repomind/core';
import { paths } from './config.js';
import { forbidden, EngineError } from './errors.js';
import { createCheckpoint, git, gitInfo, isGitRepo } from './git.js';
import type { ProjectRegistry } from './projects.js';

type CheckResult = EngineMethods['patch.check']['result'];

/** Validates a patch: syntax, paths (incl. symlink escape), secrets, deletions, dirty overlap, git apply --check. */
export async function checkPatch(
  registry: ProjectRegistry,
  project: EngineProject,
  diff: string,
  opts: { allowDeletes?: boolean; allowSecretFiles?: boolean }
): Promise<CheckResult & { normalized: string }> {
  const parsed = parseUnifiedDiff(diff);
  const issues: PatchIssue[] = [...parsed.issues];
  const files = parsed.files.map((f) => f.path);
  const known = new Set<string>();
  for (const f of parsed.files) {
    for (const p of [f.oldPath, f.newPath]) {
      if (!p) continue;
      try {
        const abs = registry.resolveInside(project, p);
        if (existsSync(abs)) known.add(p);
      } catch (e) {
        issues.push({ severity: 'error', path: p, message: (e as Error).message });
      }
    }
  }
  issues.push(...validatePatchPaths(parsed, { knownFiles: known, allowDeletes: opts.allowDeletes, allowSecretFiles: opts.allowSecretFiles }));
  const normalized = parsed.files.length ? formatUnifiedDiff(parsed) : '';
  let gitCheck = { ran: false, ok: false, output: '' };
  let dirtyOverlap: string[] = [];
  const hasErrors = issues.some((i) => i.severity === 'error');
  if (await isGitRepo(project.root)) {
    const info = await gitInfo(project.root);
    const dirty = new Set(info.dirty.map((d) => d.path));
    dirtyOverlap = files.filter((f) => dirty.has(f));
    if (!hasErrors && normalized) {
      const r = await git(project.root, ['apply', '--check', '--verbose', '--recount', '--whitespace=nowarn', '-'], { input: normalized });
      gitCheck = { ran: true, ok: r.code === 0, output: (r.stdout + r.stderr).trim().slice(0, 20000) };
      if (r.code !== 0) issues.push({ severity: 'error', message: 'git apply --check failed: the patch does not apply cleanly to the current files.' });
    }
  } else if (!hasErrors) {
    // Non-git folder: simulate in memory.
    let ok = true;
    const out: string[] = [];
    for (const f of parsed.files) {
      const abs = registry.resolveInside(project, f.oldPath ?? f.path);
      const before = f.status === 'added' ? null : existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      const r = applyFilePatch(before, f);
      if (!r.ok) {
        ok = false;
        out.push(...r.failed.map((x) => `${f.path}: ${x.reason}`));
      } else out.push(`${f.path}: ok${r.fuzzy.length ? ' (with fuzz)' : ''}`);
    }
    gitCheck = { ran: false, ok, output: out.join('\n') };
    if (!ok) issues.push({ severity: 'error', message: 'Patch does not apply to the current files.' });
  }
  return { ok: !issues.some((i) => i.severity === 'error'), issues, gitCheck, dirtyOverlap, files, normalized };
}

export async function applyPatch(
  registry: ProjectRegistry,
  project: EngineProject,
  diff: string,
  opts: { allowDeletes?: boolean; allowDirtyOverlap?: boolean; allowSecretFiles?: boolean }
): Promise<EngineMethods['patch.apply']['result']> {
  const check = await checkPatch(registry, project, diff, opts);
  if (!check.ok) throw new EngineError('CONFLICT', 'Patch failed validation; nothing was changed.', check.issues.filter((i) => i.severity === 'error'));
  if (check.dirtyOverlap.length && !opts.allowDirtyOverlap) {
    throw new EngineError('CONFLICT', `The patch touches files with uncommitted changes: ${check.dirtyOverlap.join(', ')}. Confirm “apply on top of my changes” or commit/stash them first.`, check.dirtyOverlap);
  }
  if (check.gitCheck.ran) {
    const checkpoint = await createCheckpoint(project.root, `before applying patch to ${check.files.slice(0, 3).join(', ')}`);
    const r = await git(project.root, ['apply', '--recount', '--whitespace=nowarn', '-'], { input: check.normalized });
    if (r.code !== 0) throw new EngineError('CONFLICT', `git apply failed: ${r.stderr.trim()}`);
    return { applied: true, checkpoint, files: check.files, output: (r.stdout + r.stderr).trim(), method: 'git-apply' };
  }
  // Non-git: transactional in-memory application with backups.
  const parsed = parseUnifiedDiff(check.normalized);
  const backupDir = join(paths.state, 'backups', `${project.id}-${Date.now()}`);
  const planned: { abs: string; content: string | null; oldAbs?: string }[] = [];
  for (const f of parsed.files) {
    const oldAbs = registry.resolveInside(project, f.oldPath ?? f.path);
    const newAbs = registry.resolveInside(project, f.newPath ?? f.path);
    const before = f.status === 'added' ? null : readFileSync(oldAbs, 'utf8');
    const r = applyFilePatch(before, f);
    if (!r.ok) throw new EngineError('CONFLICT', `Could not apply ${f.path}`);
    planned.push({ abs: newAbs, content: r.content, oldAbs: f.status === 'renamed' ? oldAbs : undefined });
  }
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  for (const p of planned) {
    for (const src of [p.abs, p.oldAbs]) {
      if (src && existsSync(src)) {
        const dest = join(backupDir, src.slice(project.root.length + 1));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(src));
      }
    }
  }
  for (const p of planned) {
    if (p.content === null) {
      if (existsSync(p.abs)) rmSync(p.abs);
      continue;
    }
    mkdirSync(dirname(p.abs), { recursive: true });
    const tmp = `${p.abs}.repomind-tmp`;
    writeFileSync(tmp, p.content);
    renameSync(tmp, p.abs);
    if (p.oldAbs && p.oldAbs !== p.abs && existsSync(p.oldAbs)) rmSync(p.oldAbs);
  }
  return { applied: true, checkpoint: backupDir, files: check.files, output: `Applied without git. Backups in ${backupDir}`, method: 'in-memory' };
}

export async function revertPatch(project: EngineProject, diff: string): Promise<{ reverted: boolean; output: string }> {
  if (!(await isGitRepo(project.root))) throw forbidden('Reverting is supported for git repositories. For other folders restore from the backup directory reported at apply time.');
  const normalized = formatUnifiedDiff(parseUnifiedDiff(diff));
  const check = await git(project.root, ['apply', '-R', '--check', '--recount', '-'], { input: normalized });
  if (check.code !== 0) throw new EngineError('CONFLICT', `The patch cannot be reverted cleanly (files changed since): ${check.stderr.trim()}`);
  await createCheckpoint(project.root, 'before reverting a RepoMind patch');
  const r = await git(project.root, ['apply', '-R', '--recount', '-'], { input: normalized });
  return { reverted: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

