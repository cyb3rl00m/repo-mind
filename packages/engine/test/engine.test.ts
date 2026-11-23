import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { ChunkAssembler, diffTexts, formatUnifiedDiff, type EngineMethod, type EngineMethods, type HostMessage, type ResponseEnvelope } from '@repomind/core';
import { FrameDecoder, NativeMessagingIO, encodeFrame } from '../src/nm.js';

const ENGINE_SRC = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../../benchmarks/fixtures/', import.meta.url));
const ORIGIN = 'chrome-extension://ddblnfbnekcpcpnnbeioffideiikfgmp/';

/** Minimal Native Messaging client that behaves like Chrome. */
class TestClient {
  private decoder = new FrameDecoder();
  private asm = new ChunkAssembler();
  private waiters = new Map<string, (r: ResponseEnvelope) => void>();
  readonly events: HostMessage[] = [];
  chunkCount = 0;
  private seq = 0;
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (d: Buffer) => {
      for (const raw of this.decoder.push(d)) {
        const m = raw as HostMessage;
        if ('chunk' in m) {
          this.chunkCount++;
          const done = this.asm.push(m);
          if (done) this.waiters.get(done.id)?.(done);
        } else if ('event' in m) this.events.push(m);
        else this.waiters.get(m.id)?.(m);
      }
    });
  }
  call<M extends EngineMethod>(method: M, params: EngineMethods[M]['params'] | Record<string, unknown>): Promise<ResponseEnvelope<M>> {
    const id = `t${++this.seq}`;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve as (r: ResponseEnvelope) => void);
      this.child.stdin.write(encodeFrame({ v: 1, id, method, params }));
    });
  }
  async ok<M extends EngineMethod>(method: M, params: EngineMethods[M]['params'] | Record<string, unknown>): Promise<EngineMethods[M]['result']> {
    const r = await this.call(method, params);
    if (!r.ok) throw new Error(`${method} failed: ${r.error.code} ${r.error.message}`);
    return r.result;
  }
}

let tmp: string;
let client: TestClient;
let child: ChildProcessWithoutNullStreams;
let repo: string;

function sh(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'repomind-engine-'));
  repo = join(tmp, 'notes');
  cpSync(join(FIXTURES, 'android-notes'), repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'initial');
  child = spawn(process.execPath, ['--import', 'tsx', ENGINE_SRC, ORIGIN], {
    env: { ...process.env, REPOMIND_CONFIG_DIR: join(tmp, 'cfg'), REPOMIND_STATE_DIR: join(tmp, 'state'), REPOMIND_DATA_DIR: join(tmp, 'data'), SHELL: '/bin/false' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  client = new TestClient(child);
});

afterAll(() => {
  child?.kill();
  rmSync(tmp, { recursive: true, force: true });
});

describe('native messaging framing', () => {
  it('round-trips frames and serializes concurrent writes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const got: unknown[] = [];
    const io = new NativeMessagingIO(input, output, (m) => got.push(m), () => {}, () => {});
    const frames = encodeFrame({ a: 1 });
    input.write(frames.subarray(0, 3));
    input.write(Buffer.concat([frames.subarray(3), encodeFrame({ b: 'ü' })]));
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual([{ a: 1 }, { b: 'ü' }]);
    const dec = new FrameDecoder();
    const received: unknown[] = [];
    output.on('data', (d: Buffer) => received.push(...dec.push(d)));
    await Promise.all([io.send({ x: 1 }), io.send({ x: 2 }), io.send({ x: 3 })]);
    expect(received).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  });
});

describe('engine process (real host over stdio)', () => {
  let projectId = '';

  it('handshakes and validates protocol versions', async () => {
    const hello = await client.ok('engine.hello', { client: 'test', protocol: 1 });
    expect(hello.protocol).toBe(1);
    expect(hello.capabilities['git']).toBe(true);
    const wrong = await client.call('engine.hello', { client: 'test', protocol: 99 });
    expect(wrong.ok).toBe(false);
    const unknown = await client.call('nope.method' as EngineMethod, {});
    expect(!unknown.ok && unknown.error.code).toBe('UNKNOWN_METHOD');
  });

  it('refuses system directories and relative paths', async () => {
    for (const p of ['/etc', '/', 'relative/path', '/usr/lib']) {
      const r = await client.call('project.register', { path: p });
      expect(r.ok, p).toBe(false);
    }
  });

  it('registers and scans a project respecting .gitignore and secret files', async () => {
    writeFileSync(join(repo, '.env'), 'TOKEN=abc');
    const proj = await client.ok('project.register', { path: repo });
    projectId = proj.id;
    expect(proj.isGit).toBe(true);
    const scan = await client.ok('project.scan', { projectId });
    const paths = scan.files.map((f) => f.path);
    expect(paths).toContain('app/src/main/java/com/example/notes/MainActivity.kt');
    expect(paths).not.toContain('.env');
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
    expect(scan.skipped.find((s) => s.path === '.env')?.reason).toMatch(/secret-file|ignored/);
    rmSync(join(repo, '.env'));
  });

  it('chunks large responses under the 1 MiB Chrome limit', async () => {
    const big = 'x'.repeat(700_000) + '\n';
    for (let i = 0; i < 4; i++) writeFileSync(join(repo, `big${i}.txt`), big);
    const before = client.chunkCount;
    const scan = await client.ok('project.scan', { projectId });
    expect(scan.files.filter((f) => f.path.startsWith('big')).length).toBe(4);
    expect(client.chunkCount - before).toBeGreaterThan(3);
    for (let i = 0; i < 4; i++) rmSync(join(repo, `big${i}.txt`));
  });

  it('blocks path traversal and symlink escape when reading files', async () => {
    symlinkSync('/etc/hostname', join(repo, 'escape-link'));
    const r = await client.ok('project.readFiles', { projectId, paths: ['../../etc/passwd', 'escape-link', 'README.md', '/etc/passwd'] });
    expect(r.files[0]!.content).toBeNull();
    expect(r.files[1]!.content).toBeNull();
    expect(r.files[1]!.error).toMatch(/symlink|outside/);
    expect(r.files[2]!.content).toContain('# Notes');
    expect(r.files[3]!.content).toBeNull();
    rmSync(join(repo, 'escape-link'));
  });

  it('reports git info', async () => {
    const info = await client.ok('git.info', { projectId });
    expect(info).toMatchObject({ isGit: true, branch: 'main', dirty: [] });
    expect(info.head).toMatch(/^[0-9a-f]{40}$/);
  });

  const vmPath = 'app/src/main/java/com/example/notes/ui/NotesViewModel.kt';
  let diff = '';

  it('validates, refuses unapproved application, applies with a checkpoint, and reverts', async () => {
    const before = readFileSync(join(repo, vmPath), 'utf8');
    diff = formatUnifiedDiff([diffTexts(vmPath, before, before.replace('if (trimmed.isEmpty()) return', 'if (trimmed.isBlank()) return'))]);
    const check = await client.ok('patch.check', { projectId, diff });
    expect(check.ok).toBe(true);
    expect(check.gitCheck).toMatchObject({ ran: true, ok: true });

    const unapproved = await client.call('patch.apply', { projectId, diff, approved: false });
    expect(!unapproved.ok && unapproved.error.code).toBe('NOT_APPROVED');
    expect(readFileSync(join(repo, vmPath), 'utf8')).toBe(before);

    const applied = await client.ok('patch.apply', { projectId, diff, approved: true });
    expect(applied.method).toBe('git-apply');
    expect(applied.checkpoint).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(repo, vmPath), 'utf8')).toContain('isBlank()');
    const cps = await client.ok('checkpoint.list', { projectId });
    expect(cps.checkpoints.length).toBeGreaterThan(0);

    const reverted = await client.ok('patch.revert', { projectId, diff, approved: true });
    expect(reverted.reverted).toBe(true);
    expect(readFileSync(join(repo, vmPath), 'utf8')).toBe(before);
  });

  it('preserves uncommitted user changes: refuses overlap unless confirmed', async () => {
    const abs = join(repo, vmPath);
    const original = readFileSync(abs, 'utf8');
    writeFileSync(abs, original + '\n// my local edit\n');
    const r = await client.call('patch.apply', { projectId, diff, approved: true });
    expect(!r.ok && r.error.code).toBe('CONFLICT');
    expect(readFileSync(abs, 'utf8')).toContain('// my local edit');
    const ok = await client.ok('patch.apply', { projectId, diff, approved: true, allowDirtyOverlap: true });
    expect(ok.applied).toBe(true);
    const after = readFileSync(abs, 'utf8');
    expect(after).toContain('// my local edit');
    expect(after).toContain('isBlank()');
    sh(repo, 'checkout', '--', vmPath);
  });

  it('rejects dangerous patches', async () => {
    const evil = '--- a/../outside.txt\n+++ b/../outside.txt\n@@ -0,0 +1 @@\n+x\n';
    const r = await client.ok('patch.check', { projectId, diff: evil });
    expect(r.ok).toBe(false);
    const secret = '--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+TOKEN=x\n';
    expect((await client.ok('patch.check', { projectId, diff: secret })).ok).toBe(false);
    const del = `diff --git a/README.md b/README.md\ndeleted file mode 100644\n--- a/README.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-# Notes\n`;
    expect((await client.ok('patch.check', { projectId, diff: del })).ok).toBe(false);
  });

  it('detects commands and only runs approved, prepared commands', async () => {
    const det = await client.ok('commands.detect', { projectId });
    expect(det.commands.map((c) => c.argv.join(' '))).toContain('./gradlew assembleDebug --console=plain');
    expect(det.toolchains.find((t) => t.name === 'git')?.available).toBe(true);

    const bad = await client.ok('commands.prepare', { projectId, commandLine: 'sudo rm -rf /' });
    expect(bad.command).toBeNull();
    expect(bad.safety.errors.length).toBeGreaterThan(0);

    const prep = await client.ok('commands.prepare', { projectId, commandLine: `node -e "console.log('hello from engine'); console.error('e: file:///x/A.kt:1:1 boom'); process.exit(3)"` });
    expect(prep.command?.available).toBe(true);
    const unapproved = await client.call('commands.run', { projectId, token: prep.command!.token, approved: false });
    expect(!unapproved.ok && unapproved.error.code).toBe('NOT_APPROVED');
    const run = await client.ok('commands.run', { projectId, token: prep.command!.token, approved: true });
    expect(run).toMatchObject({ status: 'failed', exitCode: 3, timedOut: false });
    expect(run.stdout).toContain('hello from engine');
    expect(run.stderr).toContain('boom');
    // Tokens are single-use.
    const again = await client.call('commands.run', { projectId, token: prep.command!.token, approved: true });
    expect(again.ok).toBe(false);
  });

  it('enforces command timeouts', async () => {
    const prep = await client.ok('commands.prepare', { projectId, commandLine: 'node -e "setTimeout(()=>{},60000)"' });
    const run = await client.ok('commands.run', { projectId, token: prep.command!.token, approved: true, timeoutMs: 1000 });
    expect(run).toMatchObject({ status: 'inconclusive', timedOut: true });
  });

  it('creates, lists and removes isolated worktrees', async () => {
    const created = await client.ok('worktree.create', { projectId, name: 'pinned-notes', approved: true });
    expect(created.branch).toBe('repomind/pinned-notes');
    expect(existsSync(join(created.path, 'README.md'))).toBe(true);
    const list = await client.ok('worktree.list', { projectId });
    expect(list.worktrees.find((w) => w.path === created.path)?.managed).toBe(true);
    const rmOutside = await client.call('worktree.remove', { projectId, path: repo, approved: true });
    expect(rmOutside.ok).toBe(false);
    const removed = await client.ok('worktree.remove', { projectId, path: created.path, approved: true });
    expect(removed.removed).toBe(true);
    expect(existsSync(created.path)).toBe(false);
  });

  it('reports keyring status honestly', async () => {
    const s = await client.ok('secrets.status', {});
    expect(typeof s.available).toBe('boolean');
    if (!s.available) expect(s.detail.length).toBeGreaterThan(10);
  });
});

describe('engine with a non-git folder', () => {
  it('applies patches transactionally with backups', async () => {
    const plain = join(tmp, 'plain');
    cpSync(join(FIXTURES, 'ts-shop'), plain, { recursive: true });
    const proj = await client.ok('project.register', { path: plain });
    expect(proj.isGit).toBe(false);
    const p = 'src/cart/pricing.ts';
    const before = readFileSync(join(plain, p), 'utf8');
    const diff = formatUnifiedDiff([diffTexts(p, before, before.replace("currency = 'EUR'", "currency = 'PLN'")), diffTexts('src/cart/new.ts', null, 'export const n = 1;\n')]);
    const res = await client.ok('patch.apply', { projectId: proj.id, diff, approved: true });
    expect(res.method).toBe('in-memory');
    expect(readFileSync(join(plain, p), 'utf8')).toContain("'PLN'");
    expect(readFileSync(join(plain, 'src/cart/new.ts'), 'utf8')).toBe('export const n = 1;\n');
    expect(existsSync(join(res.checkpoint!, p))).toBe(true);
  });
});
