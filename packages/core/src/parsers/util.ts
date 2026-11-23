import type { ImportRef, ParseFidelity, SymbolInfo, SymbolKind } from '../types.js';

export interface BuildInfo {
  plugins: string[];
  /** External dependency coordinates (`group:artifact:version`, npm names, crates...). */
  deps: string[];
  /** Internal project dependencies (Gradle `:core`, workspace packages). */
  projectDeps: string[];
  /** Version-catalog aliases referenced (`libs.androidx.core.ktx` -> `androidx.core.ktx`). */
  catalogDeps: string[];
  android?: {
    namespace?: string;
    applicationId?: string;
    compileSdk?: string;
    minSdk?: string;
    targetSdk?: string;
  };
  /** settings.gradle includes. */
  includes?: string[];
  rootName?: string;
  /** package.json scripts, Cargo bins, pyproject scripts. */
  scripts?: Record<string, string>;
  entry?: { kind: 'package-main' | 'package-bin'; detail: string }[];
  /** npm/cargo workspace member globs. */
  workspaces?: string[];
  name?: string;
  /** Version catalog contents (only for libs.versions.toml). */
  catalog?: Record<string, string>;
  /** AndroidManifest components. */
  components?: { kind: 'activity' | 'service' | 'receiver' | 'provider' | 'application'; name: string; launcher: boolean }[];
  permissions?: string[];
  manifestPackage?: string;
}

export interface ParseResult {
  pkg?: string;
  symbols: SymbolInfo[];
  imports: ImportRef[];
  resourceRefs: string[];
  notes: string[];
  fidelity: ParseFidelity;
  build?: BuildInfo;
  hasMain?: boolean;
}

export function emptyResult(fidelity: ParseFidelity = 'none'): ParseResult {
  return { symbols: [], imports: [], resourceRefs: [], notes: [], fidelity };
}

/** Brace depth at the start of each line (index 0 = line 1), computed on a comment/string-blanked view. */
export function lineDepths(code: string, open = '{', close = '}'): number[] {
  const depths: number[] = [0];
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === open) depth++;
    else if (c === close) depth = Math.max(0, depth - 1);
    else if (c === '\n') depths.push(depth);
  }
  return depths;
}

export interface ContainerFrame {
  name: string;
  depth: number;
  type: 'type' | 'function' | 'block';
}

/** Tracks the innermost enclosing declaration while iterating lines in order. */
export class ContainerStack {
  private readonly frames: ContainerFrame[] = [];
  /** Pops frames whose body ended; call with the depth at the start of the current line. */
  sync(depth: number): void {
    while (this.frames.length > 0 && depth <= this.frames[this.frames.length - 1]!.depth) this.frames.pop();
  }
  push(frame: ContainerFrame): void {
    this.frames.push(frame);
  }
  get top(): ContainerFrame | undefined {
    return this.frames[this.frames.length - 1];
  }
  /** Name of the innermost type (class/object/struct/impl). */
  get typeName(): string | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.type === 'type') return this.frames[i]!.name;
    return undefined;
  }
  /** True when inside a function body (locals are not symbols). */
  get inFunction(): boolean {
    return this.frames.some((f) => f.type === 'function');
  }
}

export function sym(
  name: string,
  kind: SymbolKind,
  line: number,
  signature: string,
  extra: Partial<SymbolInfo> = {}
): SymbolInfo {
  return { name, kind, line, exported: true, signature, ...extra };
}

/** Converts `ActivityMainBinding` to `activity_main` (Android ViewBinding naming). */
export function bindingToLayout(binding: string): string {
  return binding
    .replace(/Binding$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Extracts a return type from a declaration signature for languages using `): Type` or `-> Type`. */
export function returnTypeFrom(signature: string, style: 'colon' | 'arrow'): string | undefined {
  if (style === 'arrow') {
    const m = /\)\s*->\s*([^{;=]+?)\s*(where\b.*)?$/.exec(signature);
    return m?.[1]?.trim() || undefined;
  }
  // Find the colon after the closing paren of the parameter list (balanced).
  const open = signature.indexOf('(');
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    const c = signature[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        const rest = signature.slice(i + 1);
        const m = /^\s*:\s*([^={]+?)\s*(=.*|\{.*|where\b.*)?$/.exec(rest);
        return m?.[1]?.trim() || undefined;
      }
    }
  }
  return undefined;
}
