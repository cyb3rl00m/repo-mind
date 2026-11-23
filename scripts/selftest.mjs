#!/usr/bin/env node
/**
 * Installation self-test. Talks to the installed engine exactly like Chrome does (Native Messaging
 * framing over stdio) using throw-away directories — your projects and settings are not touched.
 *
 * Checks: extension<->engine protocol, git integration (checkpoint + patch apply/revert),
 * Android Gradle command detection, command approval + execution.
 *
 * Usage: node scripts/selftest.mjs [path/to/repomind-engine]
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const enginePath = process.argv[2] ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'repomind/engine/repomind-engine');
const ORIGIN = 'chrome-extension://ddblnfbnekcpcpnnbeioffideiikfgmp/';
const tmp = mkdtempSync(join(tmpdir(), 'repomind-selftest-'));
const env = { ...process.env, REPOMIND_CONFIG_DIR: join(tmp, 'cfg'), REPOMIND_STATE_DIR: join(tmp, 'state'), REPOMIND_DATA_DIR: join(tmp, 'data') };
const [bin, args] = enginePath.endsWith('.cjs') ? [process.execPath, [enginePath, ORIGIN]] : [enginePath, [ORIGIN]];
const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'inherit'] });

let buf = Buffer.alloc(0);
const waiters = new Map();
const chunks = new Map();
child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = buf.subarray(4 + len);
    if (msg.chunk) {
      const e = chunks.get(msg.id) ?? [];
      e[msg.chunk.seq] = msg.chunk.data;
      chunks.set(msg.id, e);
      if (e.filter((x) => x !== undefined).length === msg.chunk.total) waiters.get(msg.id)?.(JSON.parse(Buffer.from(e.join(''), 'base64').toString('utf8')));
    } else if (!msg.event) waiters.get(msg.id)?.(msg);
  }
});
let seq = 0;
function call(method, params = {}) {
  const id = `s${++seq}`;
  const json = Buffer.from(JSON.stringify({ v: 1, id, method, params }));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length);
  child.stdin.write(Buffer.concat([head, json]));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), 60000);
    waiters.set(id, (r) => {
      clearTimeout(t);
      if (r.ok) resolve(r.result);
      else reject(new Error(`${method}: ${r.error.code} ${r.error.message}`));
    });
  });
}

let failed = 0;
async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`  ✘ ${name}: ${e.message}`);
  }
}

console.log(`RepoMind self-test (engine: ${enginePath})`);
child.on('error', (e) => {
  console.log(`  ✘ cannot start engine: ${e.message}. Run scripts/install.sh first.`);
  process.exit(1);
});

const repo = join(tmp, 'app');
mkdirSync(join(repo, 'app/src/main/java/com/example'), { recursive: true });
writeFileSync(join(repo, 'settings.gradle.kts'), 'rootProject.name = "SelfTest"\ninclude(":app")\n');
writeFileSync(join(repo, 'app/build.gradle.kts'), 'plugins { id("com.android.application") }\nandroid { namespace = "com.example" }\n');
writeFileSync(join(repo, 'gradlew'), '#!/bin/sh\necho gradle wrapper stub\n');
chmodSync(join(repo, 'gradlew'), 0o755);
writeFileSync(join(repo, 'app/src/main/java/com/example/Main.kt'), 'package com.example\n\nfun greet() = "hello"\n');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'selftest', GIT_AUTHOR_EMAIL: 'selftest@localhost', GIT_COMMITTER_NAME: 'selftest', GIT_COMMITTER_EMAIL: 'selftest@localhost' };
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
execFileSync('git', ['add', '-A'], { cwd: repo });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env: gitEnv });

let pid;
await check('extension-to-engine connection (protocol handshake)', async () => {
  const h = await call('engine.hello', { client: 'selftest', protocol: 1 });
  return `engine ${h.engineVersion}, protocol v${h.protocol}, node ${h.node}`;
});
await check('project registration and scan', async () => {
  const p = await call('project.register', { path: repo });
  pid = p.id;
  const s = await call('project.scan', { projectId: pid });
  return `${s.files.length} files`;
});
await check('git integration (status, checkpoint, apply, revert)', async () => {
  const info = await call('git.info', { projectId: pid });
  if (info.branch !== 'main') throw new Error(`branch ${info.branch}`);
  const diff = '--- a/app/src/main/java/com/example/Main.kt\n+++ b/app/src/main/java/com/example/Main.kt\n@@ -1,3 +1,3 @@\n package com.example\n \n-fun greet() = "hello"\n+fun greet() = "hello, RepoMind"\n';
  const c = await call('patch.check', { projectId: pid, diff });
  if (!c.ok) throw new Error(JSON.stringify(c.issues));
  const a = await call('patch.apply', { projectId: pid, diff, approved: true });
  if (!readFileSync(join(repo, 'app/src/main/java/com/example/Main.kt'), 'utf8').includes('RepoMind')) throw new Error('not applied');
  await call('patch.revert', { projectId: pid, diff, approved: true });
  return `checkpoint ${String(a.checkpoint).slice(0, 10)}, reverted`;
});
await check('Android Gradle detection', async () => {
  const d = await call('commands.detect', { projectId: pid });
  const cmds = d.commands.map((c) => c.argv.join(' '));
  if (!cmds.includes('./gradlew assembleDebug --console=plain')) throw new Error(cmds.join(', '));
  const java = d.toolchains.find((t) => t.name === 'java');
  const sdk = d.toolchains.find((t) => t.name === 'Android SDK');
  return `${cmds.length} commands; java ${java?.available ? java.version ?? 'found' : 'MISSING'}; Android SDK ${sdk?.available ? sdk.path : 'not set'}`;
});
await check('command approval and execution', async () => {
  const p = await call('commands.prepare', { projectId: pid, commandLine: 'git log --oneline -1' });
  if (!p.command) throw new Error(p.safety.errors.join(' '));
  let refused = false;
  await call('commands.run', { projectId: pid, token: p.command.token, approved: false }).catch(() => (refused = true));
  if (!refused) throw new Error('unapproved command was executed');
  const p2 = await call('commands.prepare', { projectId: pid, commandLine: 'git log --oneline -1' });
  const r = await call('commands.run', { projectId: pid, token: p2.command.token, approved: true });
  if (r.status !== 'passed') throw new Error(r.stderr);
  return r.stdout.trim();
});
await check('dangerous commands are refused', async () => {
  const r = await call('commands.prepare', { projectId: pid, commandLine: 'sudo rm -rf /' });
  if (r.command) throw new Error('sudo was accepted');
  return r.safety.errors[0];
});

child.stdin.end();
rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll self-test checks passed.');
process.exit(failed ? 1 : 0);
