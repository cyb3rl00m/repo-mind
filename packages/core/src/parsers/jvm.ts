import { LineMap, scanSource, signatureFrom } from './scan.js';
import { ContainerStack, bindingToLayout, lineDepths, returnTypeFrom, sym, uniq, type ParseResult } from './util.js';
import type { ImportRef, SymbolInfo, SymbolKind } from '../types.js';

const RES_REF = /\bR\.(layout|string|drawable|id|menu|navigation|color|dimen|style|mipmap|raw|xml|anim|animator|font|array|plurals|integer|bool)\.(\w+)/g;
const BINDING_REF = /\b([A-Z]\w*?)Binding\b/g;

function annotationsBefore(lines: string[], idx: number, inline: string): string[] {
  const anns: string[] = [];
  for (const m of inline.matchAll(/@([\w.]+)/g)) anns.push(m[1]!);
  for (let i = idx - 1; i >= 0 && i >= idx - 6; i--) {
    const t = lines[i]!.trim();
    if (t === '') continue;
    if (!t.startsWith('@')) break;
    for (const m of t.matchAll(/@([\w.]+)/g)) anns.push(m[1]!);
  }
  return uniq(anns.map((a) => a.split('.').pop()!));
}

function refineClassKind(name: string, base: SymbolKind, anns: string[], header: string): SymbolKind {
  if (anns.includes('Entity')) return 'entity';
  if (anns.includes('Dao')) return 'dao';
  if (/:\s*[^{]*\b(AppCompatActivity|ComponentActivity|FragmentActivity|Activity)\b|extends\s+(AppCompatActivity|ComponentActivity|FragmentActivity|Activity)\b/.test(header) || (/Activity$/.test(name) && base === 'class')) {
    return 'activity';
  }
  if (/\b(Fragment|DialogFragment|BottomSheetDialogFragment)\s*\(/.test(header) || /extends\s+\w*Fragment\b/.test(header)) return 'fragment';
  if (/\b(ViewModel|AndroidViewModel)\s*\(/.test(header) || /extends\s+(Android)?ViewModel\b/.test(header) || anns.includes('HiltViewModel')) return 'viewmodel';
  return base;
}

function commonJvm(src: string, noComments: string): { pkg?: string; imports: ImportRef[]; resourceRefs: string[] } {
  const lm = new LineMap(src);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(noComments)?.[1];
  const imports: ImportRef[] = [];
  for (const m of noComments.matchAll(/^\s*import\s+(static\s+)?(\w+(?:\.\w+)*)(\.\*)?(?:\s+as\s+(\w+))?\s*;?/gm)) {
    const spec = m[2]! + (m[3] ?? '');
    imports.push({ spec, line: lm.lineAt(m.index!), kind: 'import', names: [m[3] ? '*' : spec.split('.').pop()!] });
  }
  const resourceRefs: string[] = [];
  for (const m of noComments.matchAll(RES_REF)) resourceRefs.push(`${m[1]}/${m[2]}`);
  for (const m of noComments.matchAll(BINDING_REF)) {
    if (m[1] === 'View' || m[1] === 'Data') continue;
    resourceRefs.push(`layout/${bindingToLayout(m[1]! + 'Binding')}`);
  }
  return { pkg, imports, resourceRefs: uniq(resourceRefs) };
}

export function parseKotlin(src: string): ParseResult {
  const { noComments, code } = scanSource(src, { comments: 'c', nestedBlock: true, tripleQuotes: true });
  const base = commonJvm(src, noComments);
  const lines = code.split('\n');
  const srcLines = src.split('\n');
  const depths = lineDepths(code);
  const stack = new ContainerStack();
  const symbols: SymbolInfo[] = [];
  let hasMain = false;
  const DECL =
    /^\s*((?:@[\w.]+(?:\([^)]*\))?\s+)*)((?:(?:public|private|protected|internal|open|abstract|sealed|data|enum|annotation|inner|value|inline|override|suspend|lateinit|const|final|external|tailrec|operator|infix|expect|actual|companion|fun)\s+)*)(class|interface|object|fun|val|var|typealias)\b\s*(?:<[^>]*>\s*)?(?:([\w.<>?]+)\.)?(`[^`]+`|\w+)?/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const depth = depths[i] ?? 0;
    stack.sync(depth);
    const m = DECL.exec(line);
    if (!m) continue;
    const mods = m[2] ?? '';
    const keyword = m[3]!;
    let name = m[5];
    if (keyword === 'object' && !name) name = /companion/.test(mods) ? 'Companion' : undefined;
    if (!name) continue;
    name = name.replace(/`/g, '');
    const lineNo = i + 1;
    const signature = signatureFrom(src, lineNo);
    const anns = annotationsBefore(srcLines, i, m[1] ?? '');
    const isPrivate = /\bprivate\b/.test(mods);
    const container = stack.typeName;

    if (keyword === 'class' || keyword === 'interface' || keyword === 'object') {
      let kind: SymbolKind = keyword === 'interface' || /\bfun\s+interface/.test(line) ? 'interface' : keyword === 'object' ? 'object' : 'class';
      if (/\benum\b/.test(mods)) kind = 'enum';
      if (anns.includes('Dao')) kind = 'dao';
      if (kind === 'class' || kind === 'object') kind = refineClassKind(name, kind, anns, signature);
      if (!stack.inFunction) symbols.push(sym(name, kind, lineNo, signature, { exported: !isPrivate, container, annotations: anns }));
      stack.push({ name, depth, type: 'type' });
    } else if (keyword === 'fun') {
      const receiver = m[4];
      if (!stack.inFunction) {
        const kind: SymbolKind = anns.includes('Composable') ? 'composable' : container ? 'method' : 'function';
        symbols.push(
          sym(name, kind, lineNo, signature, {
            exported: !isPrivate,
            container: container ?? (receiver ? receiver.replace(/<.*/, '') : undefined),
            annotations: anns,
            returnType: returnTypeFrom(signature, 'colon') ?? (/\)\s*=/.test(signature) ? undefined : 'Unit')
          })
        );
        if (name === 'main' && !container) hasMain = true;
      }
      stack.push({ name, depth, type: 'function' });
    } else if (keyword === 'typealias') {
      symbols.push(sym(name, 'type', lineNo, signature, { exported: !isPrivate }));
    } else if (!stack.inFunction) {
      const kind: SymbolKind = /\bconst\b/.test(mods) || /^[A-Z][A-Z0-9_]+$/.test(name) ? 'constant' : 'variable';
      const typeM = /:\s*([\w.<>?, ]+?)\s*(=|by\b|$)/.exec(signature.slice(signature.indexOf(name) + name.length));
      symbols.push(sym(name, kind, lineNo, signature, { exported: !isPrivate, container, returnType: typeM?.[1]?.trim(), annotations: anns }));
    }
  }
  return {
    ...base,
    symbols,
    notes: [],
    fidelity: 'lexical',
    hasMain
  };
}

const JAVA_TYPE =
  /^\s*((?:@[\w.]+(?:\([^)]*\))?\s+)*)((?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*)(class|interface|enum|record|@interface)\s+(\w+)/;
const JAVA_METHOD =
  /^\s*((?:@[\w.]+(?:\([^)]*\))?\s+)*)((?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*)(?:<[^>]+>\s+)?([\w.$]+(?:<[^;{}()]*>)?(?:\[\])*)\s+(\w+)\s*\(/;
const JAVA_FIELD =
  /^\s*((?:@[\w.]+(?:\([^)]*\))?\s+)*)((?:(?:public|private|protected|static|final|volatile|transient)\s+)+)([\w.$]+(?:<[^;{}()]*>)?(?:\[\])*)\s+(\w+)\s*(=|;)/;
const JAVA_KEYWORDS = new Set(['return', 'new', 'throw', 'else', 'if', 'for', 'while', 'switch', 'case', 'catch', 'synchronized', 'do', 'try', 'yield', 'assert']);

export function parseJava(src: string): ParseResult {
  const { noComments, code } = scanSource(src, { comments: 'c' });
  const base = commonJvm(src, noComments);
  const lines = code.split('\n');
  const srcLines = src.split('\n');
  const depths = lineDepths(code);
  const stack = new ContainerStack();
  const symbols: SymbolInfo[] = [];
  let hasMain = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const depth = depths[i] ?? 0;
    stack.sync(depth);
    const lineNo = i + 1;
    const t = JAVA_TYPE.exec(line);
    if (t) {
      const name = t[4]!;
      const signature = signatureFrom(src, lineNo);
      const anns = annotationsBefore(srcLines, i, t[1] ?? '');
      const kw = t[3]!;
      let kind: SymbolKind = kw === 'interface' || kw === '@interface' ? 'interface' : kw === 'enum' ? 'enum' : kw === 'record' ? 'record' : 'class';
      if (kind === 'class') kind = refineClassKind(name, kind, anns, signature);
      if (!stack.inFunction) {
        symbols.push(sym(name, kind, lineNo, signature, { exported: !/\bprivate\b/.test(t[2] ?? ''), container: stack.typeName, annotations: anns }));
      }
      stack.push({ name, depth, type: 'type' });
      continue;
    }
    if (stack.inFunction || !stack.typeName) continue;
    const mm = JAVA_METHOD.exec(line);
    if (mm && !JAVA_KEYWORDS.has(mm[3]!) && !JAVA_KEYWORDS.has(mm[4]!)) {
      const name = mm[4]!;
      const signature = signatureFrom(src, lineNo);
      const anns = annotationsBefore(srcLines, i, mm[1] ?? '');
      symbols.push(
        sym(name, 'method', lineNo, signature, {
          exported: !/\bprivate\b/.test(mm[2] ?? ''),
          container: stack.typeName,
          returnType: mm[3],
          annotations: anns
        })
      );
      if (name === 'main' && /\bstatic\b/.test(mm[2] ?? '')) hasMain = true;
      if (/\{\s*$|\{[^}]*$/.test(line) || /\)\s*(throws [\w., ]+)?\s*$/.test(line)) stack.push({ name, depth, type: 'function' });
      continue;
    }
    // Constructors: `public Foo(` inside class Foo.
    const ctor = /^\s*(?:public|private|protected)?\s*(\w+)\s*\(/.exec(line);
    if (ctor && ctor[1] === stack.typeName) {
      stack.push({ name: ctor[1]!, depth, type: 'function' });
      continue;
    }
    const f = JAVA_FIELD.exec(line);
    if (f) {
      const name = f[4]!;
      const isConst = /\bstatic\b/.test(f[2]!) && /\bfinal\b/.test(f[2]!);
      symbols.push(
        sym(name, isConst ? 'constant' : 'variable', lineNo, signatureFrom(src, lineNo, 1), {
          exported: !/\bprivate\b/.test(f[2]!),
          container: stack.typeName,
          returnType: f[3]
        })
      );
    }
  }
  return { ...base, symbols, notes: [], fidelity: 'lexical', hasMain };
}
