/**
 * Build / test output analysis: extracts diagnostics with file locations from real tool output and
 * strips noise (download progress, daemon chatter, ANSI codes) so correction prompts stay small.
 */

export interface Diagnostic {
  tool: string;
  severity: 'error' | 'warning';
  file?: string;
  line?: number;
  column?: number;
  message: string;
  code?: string;
}

export interface FailedTest {
  name: string;
  file?: string;
  message?: string;
}

export interface LogAnalysis {
  diagnostics: Diagnostic[];
  failedTests: FailedTest[];
  failingTasks: string[];
  /** Condensed log: relevant lines with a little context. */
  excerpt: string;
  summaryLine?: string;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

const NOISE: RegExp[] = [
  /^\s*Download(ing)?\s+https?:/i,
  /^\s*Downloaded\s+https?:/i,
  /^\s*(Fetching|Fetched|Resolving|Resolved|Unpacking|Compiling)\b(?!.*(error|warning))/,
  /^\s*<[-=]*>?\s*\d+% (EXECUTING|CONFIGURING|INITIALIZING|WAITING)/,
  /^\s*> (Task|Configure) .* (UP-TO-DATE|NO-SOURCE|SKIPPED|FROM-CACHE)$/,
  /^Starting a Gradle Daemon|^Daemon will be stopped|^To honour the JVM settings|^Welcome to Gradle|^Here are the highlights/,
  /^npm (notice|http fetch|timing)\b/,
  /^\s*[|/\\-]\s*$/,
  /^\s*\d+(\.\d+)?\s*(KB|MB|kB)\/s/,
  /^\s*$/
];

export function isNoise(line: string): boolean {
  return NOISE.some((re) => re.test(line));
}

type Extractor = (line: string, next: string[]) => Diagnostic | null;

const EXTRACTORS: Extractor[] = [
  // Kotlin (new): e: file:///path/File.kt:12:5 Unresolved reference: foo
  (l) => {
    const m = /^([ew]): (?:file:\/\/)?(\/?[^:\s]+\.kts?):(\d+):(\d+) (.+)$/.exec(l);
    return m ? { tool: 'kotlinc', severity: m[1] === 'e' ? 'error' : 'warning', file: m[2], line: +m[3]!, column: +m[4]!, message: m[5]! } : null;
  },
  // Kotlin (old): e: /path/File.kt: (12, 5): message
  (l) => {
    const m = /^([ew]): (\/?[^:\s]+\.kts?): \((\d+), (\d+)\): (.+)$/.exec(l);
    return m ? { tool: 'kotlinc', severity: m[1] === 'e' ? 'error' : 'warning', file: m[2], line: +m[3]!, column: +m[4]!, message: m[5]! } : null;
  },
  // javac / gcc / clang / go: path:line:col: error: msg   |   path:line: error: msg
  (l) => {
    const m = /^(\.?\.?\/?[^\s:]+\.(java|c|cc|cpp|cxx|h|hpp|m|mm)):(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.+)$/.exec(l);
    return m ? { tool: m[2] === 'java' ? 'javac' : 'cc', severity: m[5] === 'warning' ? 'warning' : 'error', file: m[1], line: +m[3]!, column: m[4] ? +m[4] : undefined, message: m[6]! } : null;
  },
  (l) => {
    const m = /^(\.?\.?\/?[^\s:]+\.go):(\d+):(\d+):\s*(.+)$/.exec(l);
    return m ? { tool: 'go', severity: 'error', file: m[1]!.replace(/^\.\//, ''), line: +m[2]!, column: +m[3]!, message: m[4]! } : null;
  },
  // tsc: src/a.ts(12,5): error TS2304: Cannot find name 'x'.
  (l) => {
    const m = /^(.+?\.[cm]?[jt]sx?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/.exec(l);
    return m ? { tool: 'tsc', severity: m[4] as 'error' | 'warning', file: m[1], line: +m[2]!, column: +m[3]!, message: m[6]!, code: m[5] } : null;
  },
  // tsc pretty / vite / esbuild: src/a.ts:12:5 - error TS2304: msg
  (l) => {
    const m = /^(.+?\.[cm]?[jt]sx?):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$/.exec(l);
    return m ? { tool: 'tsc', severity: m[4] as 'error' | 'warning', file: m[1], line: +m[2]!, column: +m[3]!, message: m[6]!, code: m[5] } : null;
  },
  // eslint (unix formatter) / generic file:line:col: message
  (l) => {
    const m = /^(.+?\.[cm]?[jt]sx?):(\d+):(\d+): (.+?)(?: \[(Error|Warning)\/([\w@/-]+)\])?$/.exec(l);
    return m ? { tool: 'eslint', severity: m[5] === 'Warning' ? 'warning' : 'error', file: m[1], line: +m[2]!, column: +m[3]!, message: m[4]!, code: m[6] } : null;
  },
  // rustc: error[E0425]: cannot find value `x` in this scope  \n  --> src/main.rs:3:5
  (l, next) => {
    const m = /^(error|warning)(?:\[(E\d+)\])?: (.+)$/.exec(l);
    if (!m) return null;
    const loc = next.slice(0, 3).map((n) => /^\s*--> (.+?):(\d+):(\d+)/.exec(n)).find(Boolean);
    if (!loc) return null;
    return { tool: 'rustc', severity: m[1] as 'error' | 'warning', file: loc[1], line: +loc[2]!, column: +loc[3]!, message: m[3]!, code: m[2] };
  },
  // Python traceback frame: File "x.py", line 12, in foo  (message comes from the last line)
  (l, next) => {
    const m = /^\s*File "(.+?\.py)", line (\d+)/.exec(l);
    if (!m) return null;
    if (next.some((n) => /^\s*File "/.test(n))) return null; // only the innermost frame
    const msg = next.find((n) => /^\w*(Error|Exception)\b|^\w+: /.test(n.trim()));
    return { tool: 'python', severity: 'error', file: m[1], line: +m[2]!, message: msg?.trim() ?? 'Exception' };
  },
  // Android resource linking: ERROR: /path/res/layout/x.xml:12: AAPT: error: msg
  (l) => {
    const m = /^(?:ERROR:\s*)?(\/?[^\s:]+\.xml):(\d+):\s*AAPT:\s*error:\s*(.+)$/.exec(l);
    return m ? { tool: 'aapt', severity: 'error', file: m[1], line: +m[2]!, message: m[3]! } : null;
  },
  // Android lint text output: path:12: Error: message [Id]
  (l) => {
    const m = /^(\/?[^\s:]+\.(?:kt|java|xml)):(\d+): (Error|Warning): (.+?)(?: \[(\w+)\])?$/.exec(l);
    return m ? { tool: 'android-lint', severity: m[3] === 'Error' ? 'error' : 'warning', file: m[1], line: +m[2]!, message: m[4]!, code: m[5] } : null;
  },
  // mypy / ruff: path.py:12: error: msg   |  path.py:12:5: F401 msg
  (l) => {
    const m = /^(.+?\.py):(\d+):(?:(\d+):)? (?:(error|warning|note): )?([A-Z]+\d+ )?(.+)$/.exec(l);
    if (!m || m[4] === 'note') return null;
    return { tool: m[5] ? 'ruff' : 'mypy', severity: m[4] === 'warning' ? 'warning' : 'error', file: m[1], line: +m[2]!, column: m[3] ? +m[3] : undefined, message: m[6]!, code: m[5]?.trim() };
  }
];

function relativize(file: string | undefined, root?: string): string | undefined {
  if (!file) return file;
  let f = file.replace(/^file:\/\//, '');
  if (root && f.startsWith(root.endsWith('/') ? root : root + '/')) f = f.slice(root.length).replace(/^\//, '');
  return f.replace(/^\.\//, '');
}

/**
 * Parses tool output. `root` (absolute project path) is stripped from absolute file paths so
 * diagnostics map onto repository files.
 */
export function analyzeLog(output: string, root?: string, maxExcerptLines = 160): LogAnalysis {
  const lines = stripAnsi(output).replace(/\r\n?/g, '\n').split('\n');
  const diagnostics: Diagnostic[] = [];
  const failedTests: FailedTest[] = [];
  const failingTasks: string[] = [];
  const keep = new Set<number>();
  let summaryLine: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const next = lines.slice(i + 1, i + 12);
    for (const ex of EXTRACTORS) {
      const d = ex(l, next);
      if (d) {
        d.file = relativize(d.file, root);
        diagnostics.push(d);
        for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 4); k++) keep.add(k);
        break;
      }
    }
    const task = /^> Task (:\S+) FAILED$/.exec(l) ?? /^Execution failed for task '(:\S+)'/.exec(l);
    if (task && !failingTasks.includes(task[1]!)) {
      failingTasks.push(task[1]!);
      keep.add(i);
    }
    // JUnit via Gradle: "FooTest > bar() FAILED"
    const junit = /^(\S+) > (.+?) FAILED$/.exec(l);
    if (junit) {
      failedTests.push({ name: `${junit[1]} > ${junit[2]}`, message: lines[i + 1]?.trim() });
      for (let k = i; k <= Math.min(lines.length - 1, i + 4); k++) keep.add(k);
    }
    // pytest: FAILED tests/test_x.py::test_y - AssertionError: ...
    const py = /^FAILED (\S+?\.py)::(\S+)(?: - (.+))?$/.exec(l);
    if (py) {
      failedTests.push({ name: py[2]!, file: py[1], message: py[3] });
      keep.add(i);
    }
    // jest / vitest: FAIL src/x.test.ts  /  ✗ / × test name
    const js = /^\s*(?:FAIL|❯)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)/.exec(l);
    if (js) {
      failedTests.push({ name: js[1]!, file: js[1] });
      for (let k = i; k <= Math.min(lines.length - 1, i + 8); k++) keep.add(k);
    }
    // cargo / go test
    const cargo = /^test (\S+) \.\.\. FAILED$/.exec(l) ?? /^--- FAIL: (\S+)/.exec(l);
    if (cargo) {
      failedTests.push({ name: cargo[1]! });
      for (let k = i; k <= Math.min(lines.length - 1, i + 6); k++) keep.add(k);
    }
    if (/^(BUILD (FAILED|SUCCESSFUL)|FAILURE: Build failed|error: could not compile|Tests?:\s+\d+ failed|=+ .*(failed|passed).* =+$|npm ERR! |ELIFECYCLE|FAILED \(|test result: FAILED|Found \d+ errors?)/.test(l)) {
      summaryLine ??= l.trim();
      keep.add(i);
    }
    if (/^\* What went wrong:/.test(l)) for (let k = i; k <= Math.min(lines.length - 1, i + 8); k++) keep.add(k);
    if (/(^|\s)(error|Error|ERROR)(:|\[)/.test(l) && !isNoise(l)) keep.add(i);
  }

  const excerptLines: string[] = [];
  let last = -2;
  for (const k of [...keep].sort((a, b) => a - b)) {
    const l = lines[k]!;
    if (isNoise(l) && !/error|fail/i.test(l)) continue;
    if (k !== last + 1 && excerptLines.length) excerptLines.push('  ⋮');
    excerptLines.push(l.length > 400 ? l.slice(0, 400) + '…' : l);
    last = k;
    if (excerptLines.length >= maxExcerptLines) {
      excerptLines.push(`  ⋮ (excerpt truncated at ${maxExcerptLines} lines)`);
      break;
    }
  }
  if (excerptLines.length === 0) {
    // Nothing recognized: fall back to the non-noise tail.
    const tail = lines.filter((l) => !isNoise(l)).slice(-60);
    excerptLines.push(...tail);
  }

  const dedup = new Map<string, Diagnostic>();
  for (const d of diagnostics) dedup.set(`${d.file}:${d.line}:${d.column}:${d.message}`, d);
  return { diagnostics: [...dedup.values()], failedTests, failingTasks, excerpt: excerptLines.join('\n'), summaryLine };
}
