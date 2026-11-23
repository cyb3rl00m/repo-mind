/**
 * RepoMind Native Messaging protocol (extension <-> local engine).
 *
 * Transport: Chrome Native Messaging (32-bit little-endian length prefix + UTF-8 JSON).
 * Chrome limits host->browser messages to 1 MiB, so large results are sent as CHUNK envelopes
 * whose `data` is a slice of the base64-encoded UTF-8 JSON of the final RESPONSE envelope.
 */
import type { CommandSafety, DetectedCommand } from './commands.js';
import type { IngestOptions } from './filter.js';
import type { GitHubBranch, GitHubRepoMeta } from './github.js';
import type { PatchIssue } from './diff.js';
import type { SkippedFile, SourceFile } from './types.js';

export const PROTOCOL_VERSION = 1;
export const NATIVE_HOST_NAME = 'com.repomind.engine';
/** Chrome's documented maximum for a single message from the native host. */
export const MAX_HOST_MESSAGE_BYTES = 1024 * 1024;
/** Base64 characters per chunk — keeps each chunk envelope far below the 1 MiB limit. */
export const CHUNK_DATA_CHARS = 512 * 1024;
/** Chrome's limit for browser->host messages is 64 MiB; we cap requests lower. */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export interface ToolchainInfo {
  name: string;
  available: boolean;
  version?: string;
  path?: string;
}

export interface EngineProject {
  id: string;
  root: string;
  name: string;
  isGit: boolean;
  worktreeOf?: string;
}

export interface GitInfo {
  isGit: boolean;
  branch: string | null;
  head: string | null;
  headMessage: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: { path: string; status: string }[];
  remotes: { name: string; url: string }[];
}

export interface PreparedCommand extends DetectedCommand {
  /** Opaque single-use token that binds an approval to this exact argv + cwd. */
  token: string;
  absoluteCwd: string;
  available: boolean;
}

export interface RunResult {
  runId: string;
  status: 'passed' | 'failed' | 'inconclusive';
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  argv: string[];
  cwd: string;
  startedAt: string;
}

export interface EngineMethods {
  'engine.hello': { params: { client: string; protocol: number }; result: { engineVersion: string; protocol: number; platform: string; arch: string; node: string; capabilities: Record<string, boolean>; configPath: string; logPath: string } };
  'project.pickFolder': { params: { title?: string }; result: { path: string | null; picker: string | null } };
  'project.register': { params: { path: string }; result: EngineProject };
  'project.list': { params: Record<string, never>; result: { projects: EngineProject[] } };
  'project.forget': { params: { projectId: string }; result: { removed: boolean } };
  'project.scan': { params: { projectId: string; options?: IngestOptions }; result: { files: SourceFile[]; skipped: SkippedFile[]; root: string; durationMs: number } };
  'project.readFiles': { params: { projectId: string; paths: string[] }; result: { files: { path: string; content: string | null; error?: string }[] } };
  'git.info': { params: { projectId: string }; result: GitInfo };
  'git.diff': { params: { projectId: string; paths?: string[] }; result: { diff: string } };
  'patch.check': { params: { projectId: string; diff: string; allowDeletes?: boolean; allowSecretFiles?: boolean }; result: { ok: boolean; issues: PatchIssue[]; gitCheck: { ran: boolean; ok: boolean; output: string }; dirtyOverlap: string[]; files: string[] } };
  'patch.apply': { params: { projectId: string; diff: string; approved: boolean; allowDeletes?: boolean; allowDirtyOverlap?: boolean; allowSecretFiles?: boolean }; result: { applied: boolean; checkpoint: string | null; files: string[]; output: string; method: 'git-apply' | 'in-memory' } };
  'patch.revert': { params: { projectId: string; diff: string; approved: boolean }; result: { reverted: boolean; output: string } };
  'checkpoint.list': { params: { projectId: string }; result: { checkpoints: { ref: string; sha: string; date: string; subject: string }[] } };
  'worktree.create': { params: { projectId: string; name: string; approved: boolean }; result: { project: EngineProject; branch: string; path: string } };
  'worktree.list': { params: { projectId: string }; result: { worktrees: { path: string; branch: string | null; head: string; managed: boolean }[] } };
  'worktree.remove': { params: { projectId: string; path: string; approved: boolean }; result: { removed: boolean; output: string } };
  'commands.detect': { params: { projectId: string }; result: { commands: PreparedCommand[]; toolchains: ToolchainInfo[] } };
  'commands.prepare': { params: { projectId: string; commandLine: string; cwd?: string }; result: { command: PreparedCommand | null; safety: CommandSafety } };
  'commands.run': { params: { projectId: string; token: string; approved: boolean; timeoutMs?: number }; result: RunResult };
  'commands.cancel': { params: { runId: string }; result: { cancelled: boolean } };
  'secrets.status': { params: Record<string, never>; result: { backend: 'secret-tool' | 'none'; available: boolean; hasGithubToken: boolean; detail: string } };
  'secrets.setGithubToken': { params: { token: string }; result: { stored: boolean; login: string | null; classic: boolean; scopes: string[] | null; warning: string | null } };
  'secrets.deleteGithubToken': { params: Record<string, never>; result: { deleted: boolean } };
  'github.fetch': { params: { owner: string; repo: string; ref?: string; subPath?: string; useToken: boolean; options?: IngestOptions }; result: { meta: GitHubRepoMeta; branches: GitHubBranch[]; ref: string; commit: { sha: string; message: string; date: string | null }; files: SourceFile[]; skipped: SkippedFile[] } };
}

export type EngineMethod = keyof EngineMethods;

export interface RequestEnvelope<M extends EngineMethod = EngineMethod> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  method: M;
  params: EngineMethods[M]['params'];
}

export interface ErrorInfo {
  code: 'BAD_REQUEST' | 'UNKNOWN_METHOD' | 'NOT_FOUND' | 'FORBIDDEN' | 'NOT_APPROVED' | 'UNAVAILABLE' | 'CONFLICT' | 'TIMEOUT' | 'INTERNAL' | 'PROTOCOL';
  message: string;
  details?: unknown;
}

export type ResponseEnvelope<M extends EngineMethod = EngineMethod> =
  | { v: typeof PROTOCOL_VERSION; id: string; ok: true; result: EngineMethods[M]['result'] }
  | { v: typeof PROTOCOL_VERSION; id: string; ok: false; error: ErrorInfo };

export interface ChunkEnvelope {
  v: typeof PROTOCOL_VERSION;
  id: string;
  chunk: { seq: number; total: number; data: string };
}

export interface EventEnvelope {
  v: typeof PROTOCOL_VERSION;
  id: string;
  event: 'progress' | 'output';
  data: { message?: string; done?: number; total?: number; stream?: 'stdout' | 'stderr'; text?: string };
}

export type HostMessage = ResponseEnvelope | ChunkEnvelope | EventEnvelope;

// ------------------------------------------------------------------ base64 helpers (isomorphic)

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

export function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Splits a response into chunk envelopes when its JSON exceeds the safe single-message size. */
export function encodeHostResponse(resp: ResponseEnvelope, maxBytes = MAX_HOST_MESSAGE_BYTES - 64 * 1024, chunkChars = CHUNK_DATA_CHARS): HostMessage[] {
  const json = JSON.stringify(resp);
  if (new TextEncoder().encode(json).length <= maxBytes) return [resp];
  const b64 = utf8ToBase64(json);
  const total = Math.ceil(b64.length / chunkChars);
  const out: ChunkEnvelope[] = [];
  for (let seq = 0; seq < total; seq++) out.push({ v: PROTOCOL_VERSION, id: resp.id, chunk: { seq, total, data: b64.slice(seq * chunkChars, (seq + 1) * chunkChars) } });
  return out;
}

/** Reassembles chunked responses on the extension side. */
export class ChunkAssembler {
  private readonly parts = new Map<string, { total: number; got: number; data: string[] }>();

  /** Returns the completed response when the last chunk arrives, otherwise null. */
  push(msg: ChunkEnvelope): ResponseEnvelope | null {
    const { id, chunk } = msg;
    if (!Number.isInteger(chunk.seq) || !Number.isInteger(chunk.total) || chunk.total < 1 || chunk.seq < 0 || chunk.seq >= chunk.total) {
      throw new Error('Malformed chunk envelope');
    }
    let entry = this.parts.get(id);
    if (!entry) {
      entry = { total: chunk.total, got: 0, data: new Array(chunk.total) };
      this.parts.set(id, entry);
    }
    if (entry.total !== chunk.total) throw new Error('Chunk total mismatch');
    if (entry.data[chunk.seq] === undefined) entry.got++;
    entry.data[chunk.seq] = chunk.data;
    if (entry.got < entry.total) return null;
    this.parts.delete(id);
    return JSON.parse(base64ToUtf8(entry.data.join(''))) as ResponseEnvelope;
  }

  pending(id: string): { got: number; total: number } | null {
    const e = this.parts.get(id);
    return e ? { got: e.got, total: e.total } : null;
  }

  drop(id: string): void {
    this.parts.delete(id);
  }
}

export function isChunk(m: HostMessage): m is ChunkEnvelope {
  return 'chunk' in m;
}

export function isEvent(m: HostMessage): m is EventEnvelope {
  return 'event' in m;
}
