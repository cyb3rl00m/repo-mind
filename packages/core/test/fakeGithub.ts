import { strToU8, zipSync } from 'fflate';
import type { FetchLike } from '@repomind/core';

/** In-memory GitHub REST fake: enough of the API for snapshots and publishing. */
export class FakeGitHub {
  commits = new Map<string, { tree: Map<string, { content: string; mode: string }>; parents: string[]; message: string }>();
  branches = new Map<string, string>();
  calls: { method: string; path: string; auth?: string }[] = [];
  writeAllowed = true;
  private n = 0;

  constructor(
    readonly owner = 'me',
    readonly repo = 'app',
    readonly defaultBranch = 'main'
  ) {}

  seed(files: Record<string, string>, branch = this.defaultBranch): string {
    const tree = new Map(Object.entries(files).map(([p, c]) => [p, { content: c, mode: '100644' }]));
    const sha = this.sha();
    this.commits.set(sha, { tree, parents: [], message: 'seed' });
    this.branches.set(branch, sha);
    return sha;
  }

  private sha(): string {
    this.n++;
    return this.n.toString(16).padStart(40, 'a');
  }

  files(branch = this.defaultBranch): Record<string, string> {
    const head = this.branches.get(branch);
    if (!head) return {};
    return Object.fromEntries([...this.commits.get(head)!.tree].map(([p, v]) => [p, v.content]));
  }

  mode(path: string, branch = this.defaultBranch): string | undefined {
    return this.commits.get(this.branches.get(branch)!)!.tree.get(path)?.mode;
  }

  fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = url.replace('https://api.github.com', '');
    this.calls.push({ method, path, auth: init?.headers?.['Authorization'] });
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const ok = (j: unknown, status = 200) => ({ ok: true, status, headers: { get: () => null }, json: async () => j, arrayBuffer: async () => new ArrayBuffer(0) });
    const err = (status: number, message: string) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({ message }), arrayBuffer: async () => new ArrayBuffer(0) });
    const base = `/repos/${this.owner}/${this.repo}`;
    const empty = this.branches.size === 0;
    if (method !== 'GET' && !this.writeAllowed) return err(403, 'Resource not accessible by personal access token');

    if (method === 'GET' && path === base) return ok({ full_name: `${this.owner}/${this.repo}`, default_branch: this.defaultBranch, private: true, description: null, size: empty ? 0 : 1, html_url: 'x', pushed_at: null });
    if (method === 'GET' && path === `${base}/branches?per_page=100`) return ok([...this.branches].map(([name, sha]) => ({ name, commit: { sha }, protected: false })));
    let m = new RegExp(`^${base}/commits/(.+)$`).exec(path);
    if (method === 'GET' && m) {
      if (empty) return err(409, 'Git Repository is empty.');
      const sha = this.branches.get(decodeURIComponent(m[1]!)) ?? m[1]!;
      const c = this.commits.get(sha);
      return c ? ok({ sha, commit: { message: c.message, committer: { date: null } } }) : err(404, 'No commit found');
    }
    m = new RegExp(`^${base}/zipball/(.+)$`).exec(path);
    if (method === 'GET' && m) {
      const c = this.commits.get(m[1]!)!;
      const zip = zipSync(Object.fromEntries([...c.tree].map(([p, v]) => [`${this.repo}-${m![1]!.slice(0, 7)}/${p}`, strToU8(v.content)])));
      return { ok: true, status: 200, headers: { get: () => String(zip.byteLength) }, json: async () => ({}), arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer };
    }
    m = new RegExp(`^${base}/git/ref/heads/(.+)$`).exec(path);
    if (method === 'GET' && m) {
      if (empty) return err(409, 'Git Repository is empty.');
      const sha = this.branches.get(decodeURIComponent(m[1]!));
      return sha ? ok({ object: { sha } }) : err(404, 'Not Found');
    }
    m = new RegExp(`^${base}/git/commits/(.+)$`).exec(path);
    if (method === 'GET' && m) return ok({ tree: { sha: `tree-of-${m[1]}` } });
    if (method === 'POST' && path === `${base}/git/trees`) {
      if (empty) return err(409, 'Git Repository is empty.');
      const baseSha = String(body['base_tree'] ?? '').replace('tree-of-', '');
      const tree = new Map(this.commits.get(baseSha)?.tree ?? []);
      for (const e of body['tree'] as { path: string; mode: string; content?: string; sha?: null }[]) {
        if (e.sha === null) tree.delete(e.path);
        else tree.set(e.path, { content: e.content!, mode: e.mode });
      }
      const sha = this.sha();
      this.commits.set(`pending-${sha}`, { tree, parents: [], message: '' });
      return ok({ sha: `pending-${sha}` }, 201);
    }
    if (method === 'POST' && path === `${base}/git/commits`) {
      const t = this.commits.get(String(body['tree']))!;
      const sha = this.sha();
      this.commits.set(sha, { tree: t.tree, parents: body['parents'] as string[], message: String(body['message']) });
      return ok({ sha, html_url: `https://github.com/${this.owner}/${this.repo}/commit/${sha}` }, 201);
    }
    m = new RegExp(`^${base}/git/refs/heads/(.+)$`).exec(path);
    if (method === 'PATCH' && m) {
      const branch = decodeURIComponent(m[1]!);
      const parent = this.commits.get(String(body['sha']))!.parents[0];
      if (this.branches.get(branch) !== parent) return err(422, 'Update is not a fast forward');
      this.branches.set(branch, String(body['sha']));
      return ok({ object: { sha: body['sha'] } });
    }
    if (method === 'POST' && path === `${base}/git/refs`) {
      this.branches.set(String(body['ref']).replace('refs/heads/', ''), String(body['sha']));
      return ok({}, 201);
    }
    m = new RegExp(`^${base}/contents/(.+)$`).exec(path);
    if (method === 'PUT' && m) {
      const p = m[1]!.split('/').map(decodeURIComponent).join('/');
      const content = Buffer.from(String(body['content']), 'base64').toString('utf8');
      const branch = String(body['branch']);
      const head = this.branches.get(branch);
      const tree = new Map(head ? this.commits.get(head)!.tree : []);
      tree.set(p, { content, mode: '100644' });
      const sha = this.sha();
      this.commits.set(sha, { tree, parents: head ? [head] : [], message: String(body['message']) });
      this.branches.set(branch, sha);
      return ok({ commit: { sha, html_url: `https://github.com/${this.owner}/${this.repo}/commit/${sha}` } }, 201);
    }
    return err(404, `Fake GitHub: unhandled ${method} ${path}`);
  };
}
