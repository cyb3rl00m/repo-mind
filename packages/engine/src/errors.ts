import type { ErrorInfo } from '@repomind/core';

export class EngineError extends Error {
  constructor(
    readonly code: ErrorInfo['code'],
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export const bad = (msg: string, details?: unknown) => new EngineError('BAD_REQUEST', msg, details);
export const forbidden = (msg: string, details?: unknown) => new EngineError('FORBIDDEN', msg, details);
export const notFound = (msg: string) => new EngineError('NOT_FOUND', msg);
export const notApproved = (what: string) => new EngineError('NOT_APPROVED', `${what} requires explicit user approval (approved: true) from the RepoMind UI.`);
export const unavailable = (msg: string) => new EngineError('UNAVAILABLE', msg);

// ------------------------------------------------------------------ tiny runtime validation

type Obj = Record<string, unknown>;

export function obj(v: unknown, name = 'params'): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad(`${name} must be an object`);
  return v as Obj;
}

export function str(o: Obj, key: string, opts: { max?: number; optional?: false } = {}): string {
  const v = o[key];
  if (typeof v !== 'string') throw bad(`${key} must be a string`);
  if (v.includes('\0')) throw bad(`${key} must not contain NUL`);
  if (opts.max && v.length > opts.max) throw bad(`${key} is too long`);
  return v;
}

export function optStr(o: Obj, key: string, max = 4096): string | undefined {
  if (o[key] === undefined || o[key] === null) return undefined;
  return str(o, key, { max });
}

export function bool(o: Obj, key: string): boolean {
  const v = o[key];
  if (v === undefined) return false;
  if (typeof v !== 'boolean') throw bad(`${key} must be a boolean`);
  return v;
}

export function strArray(o: Obj, key: string, maxItems = 5000): string[] {
  const v = o[key];
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => typeof x === 'string' && !x.includes('\0'))) throw bad(`${key} must be an array of strings (max ${maxItems})`);
  return v as string[];
}

export function optNum(o: Obj, key: string, min: number, max: number): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw bad(`${key} must be a number between ${min} and ${max}`);
  return v;
}
