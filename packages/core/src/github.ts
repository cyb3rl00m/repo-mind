import { unzipSync } from 'fflate';
import { decodeText, looksBinary, normalizeRepoPath, dirname } from './lang.js';
import { PathFilter, type IngestOptions } from './filter.js';
import type { SkippedFile, SourceFile } from './types.js';

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or SHA given in the URL (`/tree/<ref>`), if any. */
  ref?: string;
  /** Sub-path given in the URL (`/tree/<ref>/<path>`). */
  subPath?: string;
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Parses GitHub repository references:
 *   https://github.com/owner/repo(.git)(/tree/ref/path)
 *   git@github.com:owner/repo.git, ssh://git@github.com/owner/repo
 *   github.com/owner/repo, owner/repo
 */
export function parseGitHubUrl(input: string): GitHubRepoRef | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^git\+/, '');
  let m = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s);
  if (m) return valid({ owner: m[1]!, repo: m[2]! });
  m = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/]+@)?(?:www\.)?github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(tree|blob|commit)\/([^?#]+))?\/?(?:[?#].*)?$/i.exec(s);
  if (m) {
    const ref: GitHubRepoRef = { owner: m[1]!, repo: m[2]! };
    if (m[4]) {
      const parts = decodeURIComponent(m[4]).split('/');
      ref.ref = parts[0];
      if (parts.length > 1) ref.subPath = parts.slice(1).join('/');
    }
    return valid(ref);
  }
  m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(s);
  if (m) return valid({ owner: m[1]!, repo: m[2]! });
  return null;
}

function valid(r: GitHubRepoRef): GitHubRepoRef | null {
  if (!NAME.test(r.owner) || !REPO.test(r.repo) || r.repo === '.' || r.repo === '..') return null;
  return r;
}

export interface GitHubRepoMeta {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
  sizeKb: number;
  htmlUrl: string;
  pushedAt: string | null;
}

export interface GitHubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited = false
  ) {
    super(message);
  }
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * Minimal GitHub REST client. Read-only. The token, when given, is only placed in the
 * Authorization header and never logged or returned.
 */
export class GitHubClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly token?: string,
    private readonly api = 'https://api.github.com'
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.api}${path}`, { headers: this.headers() });
    if (!res.ok) throw await this.error(res);
    return res.json();
  }

  private async error(res: { status: number; headers: { get(n: string): string | null }; json(): Promise<unknown> }): Promise<GitHubError> {
    let msg = `GitHub API error ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) msg += `: ${body.message}`;
    } catch {
      /* ignore */
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    const rateLimited = (res.status === 403 || res.status === 429) && remaining === '0';
    if (rateLimited) {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
      msg = `GitHub rate limit reached${reset ? `; resets at ${new Date(reset).toLocaleTimeString()}` : ''}. Unauthenticated requests are limited to 60/hour — add a read-only token to raise the limit.`;
    } else if (res.status === 404) {
      msg = this.token ? 'Repository not found, or the token is not authorized for it.' : 'Repository not found. If it is private, add a fine-grained read-only token.';
    } else if (res.status === 401) msg = 'GitHub rejected the token (expired or revoked).';
    return new GitHubError(msg, res.status, rateLimited);
  }

  async repo(owner: string, repo: string): Promise<GitHubRepoMeta> {
    const j = (await this.get(`/repos/${owner}/${repo}`)) as Record<string, unknown>;
    return {
      fullName: String(j['full_name']),
      defaultBranch: String(j['default_branch']),
      private: Boolean(j['private']),
      description: (j['description'] as string | null) ?? null,
      sizeKb: Number(j['size'] ?? 0),
      htmlUrl: String(j['html_url']),
      pushedAt: (j['pushed_at'] as string | null) ?? null
    };
  }

  async branches(owner: string, repo: string): Promise<GitHubBranch[]> {
    const j = (await this.get(`/repos/${owner}/${repo}/branches?per_page=100`)) as { name: string; commit: { sha: string }; protected: boolean }[];
    return j.map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected }));
  }

  async commitSha(owner: string, repo: string, ref: string): Promise<{ sha: string; message: string; date: string | null }> {
    const j = (await this.get(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`)) as { sha: string; commit: { message: string; committer?: { date?: string } } };
    return { sha: j.sha, message: j.commit.message.split('\n')[0]!, date: j.commit.committer?.date ?? null };
  }

  /** Downloads the repository snapshot at `sha` as a zip archive (one request). */
  async zipball(owner: string, repo: string, sha: string, maxBytes = 300 * 1024 * 1024): Promise<Uint8Array> {
    const res = await this.fetchImpl(`${this.api}/repos/${owner}/${repo}/zipball/${encodeURIComponent(sha)}`, { headers: this.headers() });
    if (!res.ok) throw await this.error(res);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > maxBytes) throw new GitHubError(`Repository archive is ${(len / 1e6).toFixed(0)} MB, above the ${(maxBytes / 1e6).toFixed(0)} MB limit.`, 413);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new GitHubError('Repository archive exceeds the size limit.', 413);
    return buf;
  }

  /** For classic tokens GitHub reports scopes; fine-grained tokens report none. */
  async tokenInfo(): Promise<{ login: string; scopes: string[] | null; classic: boolean }> {
    const res = await this.fetchImpl(`${this.api}/user`, { headers: this.headers() });
    if (!res.ok) throw await this.error(res);
    const j = (await res.json()) as { login: string };
    const scopes = res.headers.get('x-oauth-scopes');
    return { login: j.login, scopes: scopes === null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean), classic: scopes !== null };
  }
}

export interface ZipIngestResult {
  files: SourceFile[];
  skipped: SkippedFile[];
  rootPrefix: string;
}

/**
 * Extracts text files from a GitHub zipball, applying gitignore rules, default exclusions,
 * secret-file exclusion, binary detection and size limits. Optionally restricts to a sub-path.
 */
export function filesFromZip(zip: Uint8Array, opts: IngestOptions & { subPath?: string } = {}): ZipIngestResult {
  const filter = new PathFilter(opts);
  const entries = unzipSync(zip, {
    filter: (f) => !f.name.endsWith('/') && f.originalSize <= (filter.options.maxFileBytes * 4 || Infinity)
  });
  const names = Object.keys(entries);
  const rootPrefix = names.length ? names[0]!.slice(0, names[0]!.indexOf('/') + 1) : '';
  const rel = (name: string) => (rootPrefix && name.startsWith(rootPrefix) ? name.slice(rootPrefix.length) : name);
  // Load .gitignore files first so nested rules apply.
  for (const name of names) {
    const p = rel(name);
    if (p === '.gitignore' || p.endsWith('/.gitignore')) filter.addGitignore(dirname(p), decodeText(entries[name]!));
  }
  const files: SourceFile[] = [];
  const skipped: SkippedFile[] = [];
  const sub = opts.subPath ? opts.subPath.replace(/^\/+|\/+$/g, '') : '';
  for (const name of names.sort()) {
    const raw = rel(name);
    const p = normalizeRepoPath(raw);
    if (!p) continue;
    if (sub && !(p === sub || p.startsWith(`${sub}/`))) continue;
    // Directory-level ignore checks on each parent (so `build/` excludes everything inside).
    const parts = p.split('/');
    let dirIgnored = false;
    for (let k = 1; k < parts.length; k++) {
      if (filter.isIgnored(parts.slice(0, k).join('/'), true)) {
        dirIgnored = true;
        break;
      }
    }
    const bytes = entries[name]!;
    if (dirIgnored) {
      skipped.push({ path: p, reason: 'ignored' });
      continue;
    }
    const reason = filter.check(p, bytes.byteLength);
    if (reason) {
      skipped.push({ path: p, reason });
      continue;
    }
    if (looksBinary(bytes)) {
      skipped.push({ path: p, reason: 'binary' });
      continue;
    }
    if (files.length >= filter.options.maxFiles) {
      skipped.push({ path: p, reason: 'limit' });
      continue;
    }
    files.push({ path: p, content: decodeText(bytes), size: bytes.byteLength });
  }
  return { files, skipped, rootPrefix };
}
