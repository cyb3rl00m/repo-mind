import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeRepoPath, type EngineProject } from '@repomind/core';
import { paths, writeJsonAtomic } from './config.js';
import { bad, forbidden, notFound } from './errors.js';

/** Never allowed as a project root. */
const SYSTEM_DIRS = ['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/tmp', '/usr', '/var', '/opt', '/srv', '/mnt', '/media'];
/** Nothing below these may be opened either. */
const SYSTEM_SUBTREES = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/run', '/sbin', '/sys', '/usr'];

export function projectIdFor(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

/**
 * Registry of folders the user explicitly opened in RepoMind. Every filesystem operation is
 * addressed by project id and confined to that project's real path.
 */
export class ProjectRegistry {
  private projects = new Map<string, EngineProject>();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const list = JSON.parse(readFileSync(paths.projects, 'utf8')) as EngineProject[];
      for (const p of list) if (p && typeof p.id === 'string' && typeof p.root === 'string') this.projects.set(p.id, p);
    } catch {
      /* first run */
    }
  }

  private save(): void {
    writeJsonAtomic(paths.projects, [...this.projects.values()]);
  }

  list(): EngineProject[] {
    return [...this.projects.values()].filter((p) => existsSync(p.root));
  }

  register(rawPath: string, extra: Partial<EngineProject> = {}): EngineProject {
    if (!rawPath || rawPath.includes('\0')) throw bad('Invalid path');
    const expanded = rawPath === '~' ? homedir() : rawPath.startsWith('~/') ? join(homedir(), rawPath.slice(2)) : rawPath;
    if (!isAbsolute(expanded)) throw bad('Please provide an absolute folder path (or use the folder picker).');
    let real: string;
    try {
      real = realpathSync(expanded);
    } catch {
      throw notFound(`Folder not found: ${rawPath}`);
    }
    if (!statSync(real).isDirectory()) throw bad('Path is not a directory');
    if (SYSTEM_DIRS.includes(real) || SYSTEM_SUBTREES.some((d) => real.startsWith(d + '/'))) {
      throw forbidden('System directories cannot be opened as projects.');
    }
    if (real === homedir()) throw forbidden('Your whole home directory cannot be opened as a project; choose a project folder.');
    const id = projectIdFor(real);
    const project: EngineProject = { id, root: real, name: basename(real), isGit: existsSync(join(real, '.git')), ...extra };
    this.projects.set(id, project);
    this.save();
    return project;
  }

  forget(id: string): boolean {
    const had = this.projects.delete(id);
    if (had) this.save();
    return had;
  }

  get(id: string): EngineProject {
    const p = this.projects.get(id);
    if (!p) throw notFound('Unknown project. Open the folder again in RepoMind.');
    if (!existsSync(p.root)) throw notFound(`Project folder no longer exists: ${p.root}`);
    return p;
  }

  /**
   * Resolves a repository-relative path inside a project. Rejects traversal, absolute paths and
   * symlinks that point outside the project.
   */
  resolveInside(project: EngineProject, rel: string, opts: { mustExist?: boolean } = {}): string {
    const norm = normalizeRepoPath(rel);
    if (!norm) throw forbidden(`Unsafe path: ${rel}`);
    const abs = resolve(project.root, norm);
    if (!isInside(project.root, abs)) throw forbidden(`Path escapes the project: ${rel}`);
    // Check the deepest existing ancestor's real path (symlink escape protection).
    let probe = abs;
    while (!existsSync(probe) && probe !== project.root) probe = resolve(probe, '..');
    const real = realpathSync(probe);
    if (!isInside(project.root, real)) throw forbidden(`Path resolves outside the project through a symlink: ${rel}`);
    if (opts.mustExist && !existsSync(abs)) throw notFound(`File not found: ${rel}`);
    return abs;
  }
}

export function isInside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r) && !r.split(sep).includes('..'));
}
