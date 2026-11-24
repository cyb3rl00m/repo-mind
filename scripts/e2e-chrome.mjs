#!/usr/bin/env node
/* global chrome */
/**
 * End-to-end test: loads the built extension into a real Chrome/Chromium, registers the built
 * engine as a Native Messaging host in a throw-away profile, and drives the side-panel UI through
 * import -> index -> context -> patch validate/apply -> command run -> memory persistence.
 *
 * Usage: npm run build && npm run e2e   (CHROME_PATH=/path/to/chrome to override)
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'packages/extension/dist');
const ENGINE = join(ROOT, 'packages/engine/dist/repomind-engine.cjs');
const EXPECTED_ID = 'ddblnfbnekcpcpnnbeioffideiikfgmp';
const SHOTS = process.env.E2E_SCREENSHOTS ?? join(ROOT, '.e2e-profile', 'screenshots');
const CHROME = process.env.CHROME_PATH ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);

if (!existsSync(join(EXT, 'manifest.json')) || !existsSync(ENGINE)) {
  console.error('Build first: npm run build');
  process.exit(2);
}
if (!CHROME) {
  console.error('No Chrome/Chromium found; set CHROME_PATH.');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'repomind-e2e-'));
const profile = join(tmp, 'profile');
const repo = join(tmp, 'notes-app');
mkdirSync(SHOTS, { recursive: true });

// Fixture repository under git.
cpSync(join(ROOT, 'benchmarks/fixtures/android-notes'), repo, { recursive: true });
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@x' };
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env: gitEnv });

// Native host registration inside the temporary profile (Chrome also reads <user-data-dir>/NativeMessagingHosts).
const launcher = join(tmp, 'repomind-engine');
writeFileSync(
  launcher,
  `#!/bin/sh\nexport REPOMIND_CONFIG_DIR='${tmp}/cfg' REPOMIND_STATE_DIR='${tmp}/state' REPOMIND_DATA_DIR='${tmp}/data'\nexec '${process.execPath}' '${ENGINE}' "$@"\n`
);
chmodSync(launcher, 0o755);
mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
writeFileSync(
  join(profile, 'NativeMessagingHosts', 'com.repomind.engine.json'),
  JSON.stringify({ name: 'com.repomind.engine', description: 'RepoMind Local Engine (e2e)', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${EXPECTED_ID}/`] }, null, 2)
);


/** Minimal in-memory GitHub REST API, served through request interception (no network). */
function createFakeGitHub(owner, repo) {
  const commits = new Map();
  const branches = new Map();
  let n = 0;
  const sha = () => (++n).toString(16).padStart(40, 'e');
  const base = `/repos/${owner}/${repo}`;
  const json = (status, body) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  const handle = (method, path, body) => {
    const empty = branches.size === 0;
    if (method === 'GET' && path === '/user') return json(200, { login: 'e2e-user' });
    if (method === 'GET' && path === base) return json(200, { full_name: `${owner}/${repo}`, default_branch: 'main', private: false, description: null, size: empty ? 0 : 1, html_url: `https://github.com/${owner}/${repo}`, pushed_at: null });
    if (method === 'GET' && path.startsWith(`${base}/branches`)) return json(200, [...branches].map(([name, s]) => ({ name, commit: { sha: s }, protected: false })));
    let m = path.match(new RegExp(`^${base}/commits/(.+)$`));
    if (method === 'GET' && m) return empty ? json(409, { message: 'Git Repository is empty.' }) : json(200, { sha: branches.get(m[1]) ?? m[1], commit: { message: 'x', committer: { date: null } } });
    m = path.match(new RegExp(`^${base}/git/ref/heads/(.+)$`));
    if (method === 'GET' && m) return empty ? json(409, { message: 'Git Repository is empty.' }) : branches.has(decodeURIComponent(m[1])) ? json(200, { object: { sha: branches.get(decodeURIComponent(m[1])) } }) : json(404, { message: 'Not Found' });
    m = path.match(new RegExp(`^${base}/git/commits/(.+)$`));
    if (method === 'GET' && m) return json(200, { tree: { sha: `tree-${m[1]}` } });
    if (method === 'POST' && path === `${base}/git/trees`) {
      const tree = new Map(commits.get(String(body.base_tree).replace('tree-', ''))?.tree ?? []);
      for (const e of body.tree) {
        if (e.sha === null) tree.delete(e.path);
        else tree.set(e.path, e.content);
      }
      const t = `t${sha()}`;
      commits.set(t, { tree, parents: [] });
      return json(201, { sha: t });
    }
    if (method === 'POST' && path === `${base}/git/commits`) {
      const c = sha();
      commits.set(c, { tree: commits.get(body.tree).tree, parents: body.parents, message: body.message });
      return json(201, { sha: c, html_url: `https://github.com/${owner}/${repo}/commit/${c}` });
    }
    m = path.match(new RegExp(`^${base}/git/refs/heads/(.+)$`));
    if (method === 'PATCH' && m) {
      const b = decodeURIComponent(m[1]);
      if (commits.get(body.sha).parents[0] !== branches.get(b)) return json(422, { message: 'Update is not a fast forward' });
      branches.set(b, body.sha);
      return json(200, { object: { sha: body.sha } });
    }
    m = path.match(new RegExp(`^${base}/contents/(.+)$`));
    if (method === 'PUT' && m) {
      const head = branches.get(body.branch);
      const tree = new Map(head ? commits.get(head).tree : []);
      tree.set(decodeURIComponent(m[1]), Buffer.from(body.content, 'base64').toString('utf8'));
      const c = sha();
      commits.set(c, { tree, parents: head ? [head] : [], message: body.message });
      branches.set(body.branch, c);
      return json(201, { commit: { sha: c, html_url: `https://github.com/${owner}/${repo}/commit/${c}` } });
    }
    return json(404, { message: `fake: ${method} ${path}` });
  };
  return {
    handle,
    files: () => (branches.get('main') ? Object.fromEntries(commits.get(branches.get('main')).tree) : {}),
    commitCount: () => [...commits.keys()].filter((k) => !k.startsWith('t')).length
  };
}

const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✔ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✘ ${name}: ${e.message}`);
    throw e;
  }
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : true,
  userDataDir: profile,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--window-size=1280,900']
});

let page;
const clickText = async (text, selector = 'button') => {
  const handle = await page.waitForFunction(
    (sel, t) => [...document.querySelectorAll(sel)].find((el) => el.textContent?.trim() === t || el.getAttribute('aria-label') === t || el.textContent?.trim().startsWith(t)),
    { timeout: 20000 },
    selector,
    text
  );
  await handle.asElement().click();
};
const waitText = (text, timeout = 30000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
const shot = async (name) => {
  // Toasts are transient; hide them so screenshots show the screen itself.
  // (CSS only — removing React-managed nodes would break the app.)
  const style = await page.addStyleTag({ content: '.toasts { display: none !important; }' }).catch(() => null);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
  await style?.evaluate((el) => el.remove()).catch(() => undefined);
};
const setInput = async (selector, value) => {
  await page.$eval(
    selector,
    (el, v) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value
  );
};

let exitCode = 0;
try {
  console.log(`Chrome: ${CHROME}\nProfile: ${profile}`);
  await step('extension loads with the stable ID and a service worker', async () => {
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(EXPECTED_ID), { timeout: 20000 });
    if (!sw.url().startsWith(`chrome-extension://${EXPECTED_ID}/`)) throw new Error(`Unexpected ID: ${sw.url()}`);
    const worker = await sw.worker();
    const opts = await worker.evaluate(() => chrome.sidePanel.getOptions({}));
    if (!opts.path?.endsWith('sidepanel.html')) throw new Error(`side panel path: ${JSON.stringify(opts)}`);
    const behavior = await worker.evaluate(() => chrome.sidePanel.getPanelBehavior());
    if (!behavior.openPanelOnActionClick) throw new Error('openPanelOnActionClick not set');
  });

  page = await browser.newPage();
  await page.setViewport({ width: 460, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && console.log(`    [console] ${m.text()}`));

  await step('side panel UI renders', async () => {
    await page.goto(`chrome-extension://${EXPECTED_ID}/sidepanel.html`);
    await waitText('Welcome to RepoMind');
  });

  await step('extension connects to the local engine over Native Messaging', async () => {
    await page.waitForFunction(() => document.querySelector('.engine-pill')?.classList.contains('connected'), { timeout: 20000 });
    await shot('01-dashboard');
  });

  await step('local folder import indexes the repository', async () => {
    await page.click('button[aria-label="Repositories"]');
    await page.waitForSelector('input[placeholder^="/home/you"]');
    await setInput('input[placeholder^="/home/you"]', repo);
    await clickText('Open');
    await page.waitForFunction(() => [...document.querySelectorAll('.badge')].some((b) => b.textContent === 'active'), { timeout: 60000 });
    await waitText('main @');
    await shot('02-repositories');
    await page.click('button[aria-label="Dashboard"]');
    await waitText('Build context');
    await shot('02b-dashboard');
  });

  await step('explorer shows symbols and dependencies', async () => {
    await page.click('button[aria-label="Explorer"]');
    await setInput('input[aria-label="Search"]', 'NoteRepository');
    await page.waitForFunction(() => [...document.querySelectorAll('.list-item')].some((x) => x.textContent.includes('NoteRepository.kt')));
    await page.evaluate(() => [...document.querySelectorAll('.list-item')].find((x) => x.textContent.includes('NoteRepository.kt')).click());
    await waitText('Used by');
    await shot('03-explorer');
  });

  await step('project brain renders the module graph', async () => {
    await page.click('button[aria-label="Project Brain"]');
    await clickText('Module graph');
    await page.waitForSelector('svg.graph .node');
    const nodes = await page.$$eval('svg.graph .node', (n) => n.map((x) => x.textContent));
    if (!nodes.some((t) => t.includes(':app')) || !nodes.some((t) => t.includes(':core:data'))) throw new Error(`modules: ${nodes}`);
    await shot('04-brain');
  });

  await step('context builder retrieves relevant files, estimates tokens and builds a prompt with real code', async () => {
    await page.click('button[aria-label="Context Builder"]');
    await page.waitForSelector('textarea');
    await setInput('textarea', 'Add a pinned flag to Note so pinned notes are shown first in the list');
    await clickText('Find relevant code');
    await waitText('Selected files');
    await waitText('Note.kt');
    await waitText('prompt tokens');
    await clickText('Preview');
    const text = await page.$$eval('.prompt-preview', (els) => els.map((e) => e.textContent).find((t) => t.startsWith('# RepoMind')) ?? '');
    if (!text.includes('data class Note(') || !text.includes('Change Impact Report')) throw new Error('prompt missing code or impact');
    await shot('05-context');
  });

  await step('workflow task is created from the context', async () => {
    await clickText('Start workflow task');
    await waitText('Understand prompt');
    await shot('06-workflow');
  });

  const vm = 'app/src/main/java/com/example/notes/ui/NotesViewModel.kt';
  await step('patch review validates with git apply --check and applies with approval', async () => {
    const before = readFileSync(join(repo, vm), 'utf8');
    const lines = before.split('\n');
    const i = lines.findIndex((l) => l.includes('if (trimmed.isEmpty()) return'));
    const ctxA = lines.slice(i - 2, i);
    const ctxB = lines.slice(i + 1, i + 3);
    const diff = [`--- a/${vm}`, `+++ b/${vm}`, `@@ -${i - 1},5 +${i - 1},5 @@`, ...ctxA.map((l) => ` ${l}`), `-${lines[i]}`, `+${lines[i].replace('isEmpty()', 'isBlank()')}`, ...ctxB.map((l) => ` ${l}`)].join('\n') + '\n';
    await page.click('button[aria-label="Patch Review"]');
    await page.waitForSelector('textarea');
    await setInput('textarea', diff);
    await clickText('Analyze');
    await waitText('Regression checklist');
    await clickText('Validate with git apply --check');
    await waitText('Patch applies cleanly.');
    await shot('07-patch');
    await clickText('Apply patch…');
    await page.waitForSelector('.modal');
    await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Apply').click());
    await page.waitForFunction(() => document.body.innerText.includes('Applied to 1 file'), { timeout: 30000 });
    const after = readFileSync(join(repo, vm), 'utf8');
    if (!after.includes('isBlank()')) throw new Error('file not modified on disk');
    const refs = execFileSync('git', ['for-each-ref', 'refs/repomind/'], { cwd: repo, encoding: 'utf8' });
    if (!refs.trim()) throw new Error('no checkpoint ref');
  });

  await step('build & test detects Gradle commands and runs an approved command', async () => {
    await page.click('button[aria-label="Build & Test"]');
    await waitText('./gradlew assembleDebug --console=plain', 30000);
    await setInput('input[placeholder^="./gradlew :app"]', 'git status --short');
    await clickText('Check');
    await page.waitForSelector('.modal', { timeout: 15000 });
    await waitText('What it does');
    await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Run').click());
    await waitText('Execution history');
    await page.waitForFunction(() => [...document.querySelectorAll('.badge')].some((b) => b.textContent === 'passed'), { timeout: 30000 });
    await shot('08-build');
  });

  await step('project memory persists across reloads', async () => {
    await page.click('button[aria-label="Memory"]');
    await setInput('input[placeholder^="e.g. All persistence"]', 'E2E decision: notes are never hard-deleted');
    await page.keyboard.press('Enter').catch(() => undefined);
    await page.focus('input[placeholder^="e.g. All persistence"]');
    await page.keyboard.press('Enter');
    await waitText('E2E decision: notes are never hard-deleted');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.engine-pill'));
    await page.click('button[aria-label="Memory"]');
    await waitText('E2E decision: notes are never hard-deleted', 20000);
    await shot('09-memory');
  });

  await step('settings screen shows engine details and keyring status', async () => {
    await page.click('button[aria-label="Settings"]');
    await waitText('protocol v1');
    await shot('10-settings');
  });


  // ---------------------------------------------------------------- GitHub Builder (mocked GitHub API)
  const fake = createFakeGitHub('e2e-owner', 'empty-app');
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('https://api.github.com/')) {
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
      const body = req.postData() ? JSON.parse(req.postData()) : undefined;
      return req.respond(fake.handle(req.method(), url.replace('https://api.github.com', ''), body));
    }
    if (url.startsWith('https://github.com/') || url.startsWith('https://codeload.github.com/')) return req.abort();
    return req.continue();
  });

  await step('session GitHub token can be added (validated against /user)', async () => {
    await page.click('button[aria-label="Settings"]');
    await setInput('input[aria-label="GitHub token"]', 'github_pat_' + 'E'.repeat(60));
    await clickText('Use for this session');
    await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('session only'), { timeout: 20000 });
  });

  await step('an EMPTY GitHub repository imports as a project with zero files', async () => {
    await page.click('button[aria-label="Repositories"]');
    await setInput('input[placeholder="https://github.com/owner/repo"]', 'e2e-owner/empty-app');
    await page.evaluate(() => {
      const box = [...document.querySelectorAll('label.check')].find((l) => l.textContent.includes('through the local engine'))?.querySelector('input');
      if (box && box.checked) box.click();
    });
    await clickText('Import & index');
    await page.waitForFunction(() => [...document.querySelectorAll('select.project-select option')].some((o) => o.textContent === 'e2e-owner/empty-app' && o.selected), { timeout: 30000 });
    await page.click('button[aria-label="GitHub Builder"]');
    await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('empty repository'), { timeout: 20000 });
    await shot('11-builder-empty');
  });

  await step('GitHub Builder: prompt, parse DeepSeek answer, block bad files, publish to the empty repo', async () => {
    await setInput('textarea', 'Build a tiny Kotlin hello world app');
    await clickText('Copy GITHUB MODE prompt');
    const answer = [
      '## PLAN', '- `README.md` — docs', '- `src/main/kotlin/Main.kt` — entry point', '',
      '=== FILE: README.md', 'TYPE: markdown', 'ACTION: CREATE', '```markdown', '# Hello', '```', '=== END FILE', '',
      '=== FILE: src/main/kotlin/Main.kt', 'TYPE: kotlin', 'ACTION: CREATE', '```kotlin', 'fun main() {', '    println("Hello from RepoMind")', '}', '```', '=== END FILE', '',
      '=== FILE: src/main/kotlin/Broken.kt', 'TYPE: kotlin', 'ACTION: CREATE', '```kotlin', 'fun broken() {}', '// ... rest of the code', '```', '=== END FILE', '',
      '=== GITHUB MODE STATUS', 'BATCH: 1/2', 'DONE: readme and entry point', 'REMAINING: build.gradle.kts', 'MANUAL STEPS:', '- none', '=== END STATUS'
    ].join('\n');
    await setInput('textarea[placeholder^="Paste the complete answer"]', answer);
    await clickText('Check files');
    await waitText('elision placeholder');
    const states = await page.$$eval('input[aria-label^="Publish "]', (els) => els.map((e) => [e.getAttribute('aria-label'), e.checked, e.disabled]));
    const broken = states.find((x) => x[0].includes('Broken.kt'));
    if (!broken || broken[1] || !broken[2]) throw new Error(`placeholder file not blocked: ${JSON.stringify(states)}`);
    await shot('12-builder-review');
    await clickText('Publish 2 files');
    await page.waitForSelector('.modal');
    await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Publish to GitHub').click());
    await waitText('Published to', 30000);
    const files = fake.files();
    if (files['README.md'] !== '# Hello\n' || !files['src/main/kotlin/Main.kt']?.includes('Hello from RepoMind') || files['src/main/kotlin/Broken.kt']) throw new Error(`repo: ${JSON.stringify(files)}`);
    await page.waitForFunction(() => document.body.innerText.includes('build.gradle.kts'), { timeout: 20000 });
    await shot('13-builder-published');
  });

  await step('second batch updates an existing file as one fast-forward commit', async () => {
    await page.waitForFunction(() => !document.querySelector('.busy'), { timeout: 30000 });
    const before = fake.commitCount();
    const answer2 = ['=== FILE: README.md', 'ACTION: UPDATE', '```markdown', '# Hello', '', 'Run: `kotlinc src/main/kotlin/Main.kt`', '```', '=== END FILE', '', '=== FILE: build.gradle.kts', 'ACTION: CREATE', '```kotlin', 'plugins { kotlin("jvm") version "2.0.21" }', '```', '=== END FILE', '', '=== GITHUB MODE STATUS', 'BATCH: 2/2', 'DONE: build file', 'REMAINING: NONE', 'MANUAL STEPS:', '- none', '=== END STATUS'].join('\n');
    await setInput('textarea[placeholder^="Paste the complete answer"]', answer2);
    await clickText('Check files');
    await waitText('changes vs. current file');
    await clickText('Publish 2 files');
    await page.waitForSelector('.modal');
    await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === 'Publish to GitHub').click());
    await page.waitForFunction(() => [...document.querySelectorAll('.list-item')].filter((x) => x.textContent.includes('files')).length >= 2, { timeout: 30000 });
    const files = fake.files();
    if (!files['README.md'].includes('kotlinc') || !files['build.gradle.kts']) throw new Error(`repo: ${JSON.stringify(Object.keys(files))}`);
    if (fake.commitCount() - before !== 1) throw new Error(`expected 1 commit, got ${fake.commitCount() - before}`);
  });

  if (errors.length) throw new Error(`Page errors: ${errors.join(' | ')}`);
} catch (e) {
  exitCode = 1;
  if (page) await shot('failure').catch(() => undefined);
  console.error(e);
} finally {
  await browser.close();
  writeFileSync(join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
  if (!process.env.KEEP) rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed. Screenshots: ${SHOTS}`);
process.exit(exitCode);
