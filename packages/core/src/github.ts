import { unzipSync } from 'fflate';
import { decodeText, looksBinary, normalizeRepoPath, dirname } from './lang.js';
import { PathFilter, type IngestOptions } from './filter.js';
import type { SkippedFile, SourceFile } from './types.js';
import { utf8ToBase64 } from './protocol.js';
import { isSecretFile } from './secrets.js';

export interface TreeEntry {
  path: string;
  mode: '100644' | '100755';
  type: 'blob';
  content?: string;
  sha?: null;
}

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

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
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

  private async send(method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.api}${path}`, { method, headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw await this.error(res, true);
    return res.json();
  }

  private async error(res: { status: number; headers: { get(n: string): string | null }; json(): Promise<unknown> }, write = false): Promise<GitHubError> {
    let msg = `GitHub API error ${res.status}`;
    let apiMessage = '';
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) {
        apiMessage = body.message;
        msg += `: ${body.message}`;
      }
    } catch {
      /* ignore */
    }
    if (res.status === 409 && /empty/i.test(apiMessage)) return new GitHubError('The repository is empty (no commits yet).', 409);
    if (write && (res.status === 403 || res.status === 404) && res.headers.get('x-ratelimit-remaining') !== '0') {
      return new GitHubError(
        this.token
          ? 'GitHub refused the write. The token needs “Contents: Read and write” for this repository (fine-grained) or the “repo” scope (classic).'
          : 'Publishing needs a GitHub token with “Contents: Read and write” for this repository. Add one in Settings → GitHub access.',
        res.status
      );
    }
    if (write && res.status === 422) return new GitHubError(`GitHub rejected the change: ${apiMessage || 'validation failed'}. The branch may have moved — refresh and try again.`, 422);
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

  // ---------------------------------------------------------------- write API (used only after explicit user approval)

  async branchHead(owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const j = (await this.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)) as { object: { sha: string } };
      return j.object.sha;
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return null;
      throw e;
    }
  }

  async commitTree(owner: string, repo: string, sha: string): Promise<string> {
    const j = (await this.get(`/repos/${owner}/${repo}/git/commits/${sha}`)) as { tree: { sha: string } };
    return j.tree.sha;
  }

  async createTree(owner: string, repo: string, baseTree: string | null, entries: TreeEntry[]): Promise<string> {
    const j = (await this.send('POST', `/repos/${owner}/${repo}/git/trees`, baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries })) as { sha: string };
    return j.sha;
  }

  async createCommit(owner: string, repo: string, message: string, tree: string, parents: string[]): Promise<{ sha: string; htmlUrl: string }> {
    const j = (await this.send('POST', `/repos/${owner}/${repo}/git/commits`, { message, tree, parents })) as { sha: string; html_url: string };
    return { sha: j.sha, htmlUrl: j.html_url };
  }

  async updateBranch(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.send('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false });
  }

  async createBranch(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.send('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  /** Contents API: the only way to create the first commit in an empty repository. */
  async putFile(owner: string, repo: string, path: string, content: string, message: string, branch: string): Promise<{ commitSha: string; htmlUrl: string }> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const j = (await this.send('PUT', `/repos/${owner}/${repo}/contents/${encoded}`, { message, content: utf8ToBase64(content), branch })) as { commit: { sha: string; html_url: string } };
    return { commitSha: j.commit.sha, htmlUrl: j.commit.html_url };
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

// ------------------------------------------------------------------ snapshots (handles empty repositories)

export interface RepoSnapshot {
  meta: GitHubRepoMeta;
  branches: GitHubBranch[];
  ref: string;
  commit: { sha: string; message: string; date: string | null };
  files: SourceFile[];
  skipped: SkippedFile[];
  /** True when the repository has no commits yet. */
  empty: boolean;
}

export async function fetchSnapshot(
  gh: GitHubClient,
  owner: string,
  repo: string,
  ref: string | undefined,
  opts: IngestOptions & { subPath?: string },
  progress: (m: string) => void = () => {}
): Promise<RepoSnapshot> {
  progress('Fetching repository metadata');
  const meta = await gh.repo(owner, repo);
  const branches = await gh.branches(owner, repo).catch(() => []);
  const useRef = ref || meta.defaultBranch;
  let commit: RepoSnapshot['commit'];
  try {
    commit = await gh.commitSha(owner, repo, useRef);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 409) {
      progress('Repository is empty');
      return { meta, branches: [], ref: useRef, commit: { sha: '', message: '(empty repository)', date: null }, files: [], skipped: [], empty: true };
    }
    throw e;
  }
  progress(`Downloading snapshot ${commit.sha.slice(0, 10)}`);
  const zip = await gh.zipball(owner, repo, commit.sha);
  progress(`Extracting ${(zip.byteLength / 1e6).toFixed(1)} MB`);
  const r = filesFromZip(zip, opts);
  return { meta, branches, ref: useRef, commit, files: r.files, skipped: r.skipped, empty: false };
}

// ------------------------------------------------------------------ publishing

export interface PublishFile {
  path: string;
  /** null deletes the file. */
  content: string | null;
}

export interface PublishOptions {
  owner: string;
  repo: string;
  /** Branch to commit to (the repository's current branch in RepoMind). */
  branch: string;
  /** Optional: create this new branch from `branch` and commit there instead. */
  newBranch?: string;
  message: string;
  files: PublishFile[];
  /** Head SHA RepoMind's snapshot is based on; if the branch moved, publishing stops. null = expect empty repo. */
  expectedHead?: string | null;
}

export interface PublishResult {
  branch: string;
  commitSha: string;
  htmlUrl: string;
  commits: number;
  createdBranch: boolean;
  wasEmpty: boolean;
}

export const PUBLISH_LIMITS = { maxFiles: 300, maxFileBytes: 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 };

const BRANCH_NAME = /^(?!\/|.*(?:\/\/|\.\.|@\{|\\))[A-Za-z0-9._/-]{1,100}(?<![./])$/;

/** Validates a publish request. Returns blocking problems (empty = ok). */
export function validatePublish(o: Pick<PublishOptions, 'files' | 'message' | 'branch' | 'newBranch'>): string[] {
  const errors: string[] = [];
  if (!o.files.length) errors.push('Nothing to publish.');
  if (o.files.length > PUBLISH_LIMITS.maxFiles) errors.push(`Too many files (${o.files.length} > ${PUBLISH_LIMITS.maxFiles}). Publish in batches.`);
  if (!o.message.trim()) errors.push('Commit message is empty.');
  if (!BRANCH_NAME.test(o.branch)) errors.push(`Invalid branch name: ${o.branch}`);
  if (o.newBranch !== undefined && !BRANCH_NAME.test(o.newBranch)) errors.push(`Invalid new branch name: ${o.newBranch}`);
  let total = 0;
  const seen = new Set<string>();
  for (const f of o.files) {
    const p = normalizeRepoPath(f.path);
    if (!p || p !== f.path) errors.push(`Unsafe or non-normalized path: ${f.path}`);
    else if (/(^|\/)\.git(\/|$)/.test(p)) errors.push(`Refusing to write git internals: ${f.path}`);
    else if (isSecretFile(p)) errors.push(`Refusing to publish a secret/credential file: ${f.path}`);
    if (seen.has(f.path)) errors.push(`Duplicate path: ${f.path}`);
    seen.add(f.path);
    const size = f.content === null ? 0 : new TextEncoder().encode(f.content).length;
    if (size > PUBLISH_LIMITS.maxFileBytes) errors.push(`${f.path} is larger than 1 MiB.`);
    total += size;
  }
  if (total > PUBLISH_LIMITS.maxTotalBytes) errors.push('Total size exceeds 20 MiB.');
  return errors;
}

function fileMode(path: string): '100644' | '100755' {
  return /(^|\/)(gradlew|mvnw)$|\.sh$/.test(path) ? '100755' : '100644';
}

/**
 * Creates ONE commit containing all files (Git Data API) and moves the branch to it with a
 * fast-forward-only update. Empty repositories get their first commit through the Contents API
 * (GitHub does not allow Git Data writes before the first commit), then the rest in a second commit.
 */
export async function publishFiles(gh: GitHubClient, o: PublishOptions, progress: (m: string) => void = () => {}): Promise<PublishResult> {
  const problems = validatePublish(o);
  if (problems.length) throw new GitHubError(problems.join(' '), 400);
  const { owner, repo } = o;
  let head = await gh.branchHead(owner, repo, o.branch);
  if (o.expectedHead !== undefined && (o.expectedHead || null) !== head) {
    throw new GitHubError(`Branch ${o.branch} changed on GitHub since RepoMind's snapshot (expected ${o.expectedHead?.slice(0, 10) ?? 'empty'}, found ${head?.slice(0, 10) ?? 'empty'}). Refresh the project, review again, then publish.`, 409);
  }
  let files = [...o.files];
  let commits = 0;
  let wasEmpty = false;
  let last = { sha: head ?? '', htmlUrl: '' };
  let branch = o.branch;
  let createdBranch = false;

  if (!head) {
    wasEmpty = true;
    if (o.newBranch) throw new GitHubError('Cannot create a new branch in an empty repository; publish to the default branch first.', 400);
    const first = files.find((f) => f.content !== null);
    if (!first) throw new GitHubError('An empty repository needs at least one file to create.', 400);
    progress(`Creating first commit with ${first.path}`);
    const r = await gh.putFile(owner, repo, first.path, first.content!, files.length === 1 ? o.message : `${o.message} (1/2)`, branch);
    commits++;
    head = r.commitSha;
    last = { sha: r.commitSha, htmlUrl: r.htmlUrl };
    files = files.filter((f) => f !== first && f.content !== null);
  }
  if (o.newBranch) {
    progress(`Creating branch ${o.newBranch}`);
    await gh.createBranch(owner, repo, o.newBranch, head);
    branch = o.newBranch;
    createdBranch = true;
  }
  if (files.length) {
    progress(`Uploading ${files.length} file(s)`);
    const baseTree = await gh.commitTree(owner, repo, head);
    const entries: TreeEntry[] = files.map((f) => (f.content === null ? { path: f.path, mode: fileMode(f.path), type: 'blob', sha: null } : { path: f.path, mode: fileMode(f.path), type: 'blob', content: f.content }));
    const tree = await gh.createTree(owner, repo, baseTree, entries);
    progress('Creating commit');
    const c = await gh.createCommit(owner, repo, wasEmpty ? `${o.message} (2/2)` : o.message, tree, [head]);
    progress(`Updating ${branch}`);
    await gh.updateBranch(owner, repo, branch, c.sha);
    commits++;
    last = c;
  }
  return { branch, commitSha: last.sha, htmlUrl: last.htmlUrl, commits, createdBranch, wasEmpty };
}
