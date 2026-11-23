import { describe, expect, it } from 'vitest';
import {
  GitHubClient,
  buildGithubContinuePrompt,
  buildGithubFixPrompt,
  buildGithubModePrompt,
  buildIndex,
  fetchSnapshot,
  parseGithubMode,
  publishFiles,
  validatePublish
} from '@repomind/core';
import { FakeGitHub } from './fakeGithub.js';

const ANSWER = `Sure! Entering GITHUB MODE.

## PLAN
- \`settings.gradle.kts\` — modules
- \`app/build.gradle.kts\` — app module
- \`app/src/main/java/com/x/MainActivity.kt\` — main screen

=== FILE: settings.gradle.kts
TYPE: kotlin
ACTION: CREATE
\`\`\`kotlin
rootProject.name = "Todo"
include(":app")
\`\`\`
=== END FILE

=== FILE: README.md
TYPE: markdown
ACTION: UPDATE
\`\`\`\`markdown
# Todo

\`\`\`bash
./gradlew assembleDebug
\`\`\`
\`\`\`\`
=== END FILE

=== FILE: old/Legacy.kt
ACTION: DELETE
=== END FILE

=== GITHUB MODE STATUS
BATCH: 1/3
DONE: build files and readme
REMAINING: app/build.gradle.kts, app/src/main/java/com/x/MainActivity.kt
MANUAL STEPS:
- Open the project in Android Studio once to generate the Gradle wrapper.
=== END STATUS
`;

describe('GITHUB MODE parser', () => {
  it('parses files, actions, nested fences, deletes, status, plan and manual steps', () => {
    const r = parseGithubMode(ANSWER, new Set(['README.md', 'old/Legacy.kt']));
    expect(r.issues).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.files.map((f) => [f.path, f.action, f.type])).toEqual([
      ['settings.gradle.kts', 'create', 'kotlin'],
      ['README.md', 'update', 'markdown'],
      ['old/Legacy.kt', 'delete', undefined]
    ]);
    expect(r.files[0]!.content).toBe('rootProject.name = "Todo"\ninclude(":app")\n');
    expect(r.files[1]!.content).toContain('```bash\n./gradlew assembleDebug\n```');
    expect(r.files[2]!.content).toBeNull();
    expect(r.files.every((f) => f.issues.length === 0)).toBe(true);
    expect(r.batch).toEqual({ n: 1, total: 3 });
    expect(r.remaining).toEqual(['app/build.gradle.kts', 'app/src/main/java/com/x/MainActivity.kt']);
    expect(r.manualSteps).toEqual(['Open the project in Android Studio once to generate the Gradle wrapper.']);
    expect(r.plan).toHaveLength(3);
  });

  it('keeps code blocks inside markdown files (README with ```bash sections, plain ``` fence)', () => {
    const text = [
      '=== FILE: README.md', 'ACTION: CREATE', '```markdown', '# App', '', '## Build', '', '```bash', 'cmake -B build', '```', '', '## Data', '', '```', '~/.local/share/app', '```', '', 'MIT', '```', '',
      '=== FILE: src/main.cpp', 'ACTION: CREATE', '```cpp', 'int main() {}', '```'
    ].join('\n');
    const r = parseGithubMode(text, new Set());
    expect(r.files.map((f) => f.path)).toEqual(['README.md', 'src/main.cpp']);
    expect(r.files[0]!.content).toBe('# App\n\n## Build\n\n```bash\ncmake -B build\n```\n\n## Data\n\n```\n~/.local/share/app\n```\n\nMIT\n');
    expect(r.files[1]!.content).toBe('int main() {}\n');
    expect(r.files[1]!.issues.some((i) => /check that its end is complete/.test(i.message))).toBe(true);
  });

  it('detects truncated answers', () => {
    const cut = '=== FILE: a.kt\nACTION: CREATE\n```kotlin\nfun a() {\n';
    const r = parseGithubMode(cut, new Set());
    expect(r.truncated).toBe(true);
    expect(r.files[0]!.content).toBeNull();
    expect(r.issues.join(' ')).toMatch(/continue/);
  });

  it('blocks placeholders, unsafe paths, secret files, binaries, embedded secrets and bad deletes', () => {
    const key = 'ghp_' + 'Z'.repeat(36);
    const text = [
      '=== FILE: a.kt', '```kotlin', 'fun a() {}', '// ... rest of the code', '```', '=== END FILE',
      '=== FILE: ../escape.kt', '```kotlin', 'x', '```',
      '=== FILE: .env', '```', 'A=1', '```',
      '=== FILE: app/logo.png', '```', 'x', '```',
      '=== FILE: src/config.ts', '```ts', `export const t = "${key}";`, '```',
      '=== FILE: missing.kt', 'ACTION: DELETE', '=== END FILE',
      '=== GITHUB MODE STATUS', 'REMAINING: NONE', '=== END STATUS'
    ].join('\n');
    const r = parseGithubMode(text, new Set());
    const errs = Object.fromEntries(r.files.map((f) => [f.path, f.issues.filter((i) => i.severity === 'error').map((i) => i.message).join(' ')]));
    expect(errs['a.kt']).toMatch(/placeholder/);
    expect(errs['../escape.kt']).toMatch(/Unsafe/);
    expect(errs['.env']).toMatch(/Secret/);
    expect(errs['app/logo.png']).toMatch(/Binary/);
    expect(errs['src/config.ts']).toMatch(/secret-looking/);
    expect(errs['missing.kt']).toMatch(/does not exist/);
    expect(r.remaining).toEqual([]);
  });

  it('accepts markdown-style headers and reports answers without file blocks', () => {
    const r = parseGithubMode('### FILE: `src/x.ts`\n```ts\nexport const x = 1;\n```\n', new Set());
    expect(r.files[0]!.path).toBe('src/x.ts');
    expect(parseGithubMode('Here is how you could do it…', new Set()).issues[0]).toMatch(/No file blocks/);
  });
});

describe('GITHUB MODE prompts', () => {
  it('tells DeepSeek to enter GITHUB MODE with the format, tree and plan instructions', () => {
    const index = buildIndex([]);
    const p = buildGithubModePrompt({ identity: { name: 'me/app', source: 'github', owner: 'me', repo: 'app', branch: 'main' }, index, contents: new Map(), request: 'Build a todo app for Android in Kotlin' });
    expect(p.text).toContain('Enter GITHUB MODE now');
    expect(p.text).toContain('=== FILE: path/relative/to/repo/Root.kt');
    expect(p.text).toContain('=== GITHUB MODE STATUS');
    expect(p.text).toContain('empty repository');
    expect(p.text).toMatch(/PLAN/);
    expect(p.text).toContain('Build a todo app');
  });
  it('builds continue and fix prompts', () => {
    expect(buildGithubContinuePrompt({ published: ['a.kt'], remaining: ['b.kt'] }).text).toMatch(/continue[\s\S]*a\.kt[\s\S]*b\.kt/);
    expect(buildGithubFixPrompt([{ path: 'a.kt', messages: ['placeholder'] }]).text).toContain('a.kt: placeholder');
  });
});

describe('GitHub snapshots and publishing (fake GitHub)', () => {
  it('imports an empty repository as a project with zero files', async () => {
    const gh = new FakeGitHub();
    const snap = await fetchSnapshot(new GitHubClient(gh.fetch), 'me', 'app', undefined, {});
    expect(snap).toMatchObject({ empty: true, files: [], ref: 'main', commit: { sha: '' } });
    expect(buildIndex(snap.files).stats.indexedFiles).toBe(0);
  });

  it('publishes the first files into an empty repository (Contents API, then one tree commit)', async () => {
    const gh = new FakeGitHub();
    const client = new GitHubClient(gh.fetch, 'tok');
    const r = await publishFiles(client, { owner: 'me', repo: 'app', branch: 'main', message: 'Initial app', expectedHead: null, files: [
      { path: 'README.md', content: '# App\n' },
      { path: 'gradlew', content: '#!/bin/sh\n' },
      { path: 'app/src/main/java/com/x/Main.kt', content: 'fun main() {}\n' }
    ] });
    expect(r).toMatchObject({ wasEmpty: true, commits: 2, branch: 'main' });
    expect(gh.files()).toEqual({ 'README.md': '# App\n', gradlew: '#!/bin/sh\n', 'app/src/main/java/com/x/Main.kt': 'fun main() {}\n' });
    expect(gh.mode('gradlew')).toBe('100755');
    expect(gh.calls.filter((c) => c.method !== 'GET').every((c) => c.auth === 'Bearer tok')).toBe(true);
    // Snapshot after publishing sees the files.
    const snap = await fetchSnapshot(new GitHubClient(gh.fetch), 'me', 'app', undefined, {});
    expect(snap.files.map((f) => f.path).sort()).toEqual(['README.md', 'app/src/main/java/com/x/Main.kt', 'gradlew']);
  });

  it('publishes creates, updates and deletes as one fast-forward commit', async () => {
    const gh = new FakeGitHub();
    const head = gh.seed({ 'a.txt': 'a', 'b.txt': 'b' });
    const r = await publishFiles(new GitHubClient(gh.fetch, 't'), { owner: 'me', repo: 'app', branch: 'main', message: 'Change', expectedHead: head, files: [
      { path: 'a.txt', content: 'A2' },
      { path: 'b.txt', content: null },
      { path: 'c/d.txt', content: 'new' }
    ] });
    expect(r.commits).toBe(1);
    expect(gh.files()).toEqual({ 'a.txt': 'A2', 'c/d.txt': 'new' });
    expect(gh.commits.get(r.commitSha)!.parents).toEqual([head]);
  });

  it('refuses to publish when the branch moved since the snapshot', async () => {
    const gh = new FakeGitHub();
    gh.seed({ 'a.txt': 'a' });
    await expect(publishFiles(new GitHubClient(gh.fetch, 't'), { owner: 'me', repo: 'app', branch: 'main', message: 'x', expectedHead: 'f'.repeat(40), files: [{ path: 'a.txt', content: 'b' }] })).rejects.toThrow(/changed on GitHub/);
    expect(gh.files()).toEqual({ 'a.txt': 'a' });
  });

  it('can publish to a new branch instead of the current one', async () => {
    const gh = new FakeGitHub();
    const head = gh.seed({ 'a.txt': 'a' });
    const r = await publishFiles(new GitHubClient(gh.fetch, 't'), { owner: 'me', repo: 'app', branch: 'main', newBranch: 'repomind/feature', message: 'x', expectedHead: head, files: [{ path: 'a.txt', content: 'b' }] });
    expect(r).toMatchObject({ branch: 'repomind/feature', createdBranch: true });
    expect(gh.files('main')).toEqual({ 'a.txt': 'a' });
    expect(gh.files('repomind/feature')).toEqual({ 'a.txt': 'b' });
  });

  it('explains missing write permission', async () => {
    const gh = new FakeGitHub();
    gh.seed({ 'a.txt': 'a' });
    gh.writeAllowed = false;
    await expect(publishFiles(new GitHubClient(gh.fetch, 'readonly'), { owner: 'me', repo: 'app', branch: 'main', message: 'x', files: [{ path: 'a.txt', content: 'b' }] })).rejects.toThrow(/Contents: Read and write/);
  });

  it('validates publish requests', () => {
    expect(validatePublish({ files: [], message: 'x', branch: 'main' })).toContain('Nothing to publish.');
    const errs = validatePublish({ files: [{ path: '../x', content: '' }, { path: '.env', content: 'A=1' }, { path: '.git/config', content: '' }], message: ' ', branch: 'bad..name' }).join('\n');
    expect(errs).toMatch(/Unsafe/);
    expect(errs).toMatch(/secret/);
    expect(errs).toMatch(/git internals/);
    expect(errs).toMatch(/Commit message/);
    expect(errs).toMatch(/Invalid branch/);
  });
});
