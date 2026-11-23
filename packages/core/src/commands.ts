/**
 * Detection of build / test / lint commands for a project. Pure logic over a minimal filesystem
 * interface so the engine (real disk) and tests (in-memory) share it.
 */

export interface FsProbe {
  exists(rel: string): boolean;
  read(rel: string): string | null;
  isExecutable?(rel: string): boolean;
}

export type CommandCategory = 'test' | 'build' | 'lint' | 'typecheck' | 'check';

export interface DetectedCommand {
  id: string;
  label: string;
  ecosystem: 'android' | 'gradle' | 'maven' | 'node' | 'python' | 'rust' | 'go' | 'make' | 'cmake';
  category: CommandCategory;
  argv: string[];
  /** Working directory relative to the project root ('' = root). */
  cwd: string;
  description: string;
  mayDownload: boolean;
  mayModifyFiles: boolean;
  /** Tool binary that must be on PATH (or a project wrapper). */
  requires: string;
  timeoutMs: number;
}

function cmd(c: Omit<DetectedCommand, 'id'>): DetectedCommand {
  return { ...c, id: `${c.ecosystem}:${c.cwd || '.'}:${c.argv.join(' ')}` };
}

export function detectCommands(fs: FsProbe, dirs: string[] = ['']): DetectedCommand[] {
  const out: DetectedCommand[] = [];
  for (const dir of dirs) {
    const p = (rel: string) => (dir ? `${dir}/${rel}` : rel);

    // Gradle / Android
    const gradleBuild = ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'].find((f) => fs.exists(p(f)));
    if (gradleBuild) {
      const wrapper = fs.exists(p('gradlew'));
      const gradle = wrapper ? './gradlew' : 'gradle';
      const allGradle = ['build.gradle.kts', 'build.gradle', 'app/build.gradle.kts', 'app/build.gradle', 'settings.gradle.kts', 'settings.gradle']
        .map((f) => fs.read(p(f)) ?? '')
        .join('\n');
      const catalog = fs.read(p('gradle/libs.versions.toml')) ?? '';
      const android = /com\.android\.(application|library)|android\.application|android\.library|androidApplication|androidLibrary/.test(allGradle + catalog);
      const base = { cwd: dir, mayDownload: true, mayModifyFiles: true, requires: wrapper ? './gradlew (Gradle wrapper) + JDK' : 'gradle + JDK' };
      const extra = ['--console=plain'];
      if (android) {
        out.push(cmd({ ...base, label: 'Android unit tests', ecosystem: 'android', category: 'test', argv: [gradle, 'test', ...extra], description: 'Runs JVM unit tests for all Android modules (all variants).', timeoutMs: 30 * 60_000 }));
        out.push(cmd({ ...base, label: 'Assemble debug APK', ecosystem: 'android', category: 'build', argv: [gradle, 'assembleDebug', ...extra], description: 'Compiles Kotlin/Java, merges resources and builds the debug APK. Writes to build/ directories.', timeoutMs: 30 * 60_000 }));
        out.push(cmd({ ...base, label: 'Android lint', ecosystem: 'android', category: 'lint', argv: [gradle, 'lint', ...extra], description: 'Runs Android Lint and writes reports to build/reports.', timeoutMs: 30 * 60_000 }));
        out.push(cmd({ ...base, label: 'Compile Kotlin (debug)', ecosystem: 'android', category: 'check', argv: [gradle, 'compileDebugKotlin', ...extra], description: 'Fast compile check of the debug variant (fails if the task does not exist in this project).', timeoutMs: 20 * 60_000 }));
      } else {
        out.push(cmd({ ...base, label: 'Gradle test', ecosystem: 'gradle', category: 'test', argv: [gradle, 'test', ...extra], description: 'Runs the Gradle test task.', timeoutMs: 30 * 60_000 }));
        out.push(cmd({ ...base, label: 'Gradle build', ecosystem: 'gradle', category: 'build', argv: [gradle, 'build', ...extra], description: 'Compiles, tests and assembles all modules.', timeoutMs: 30 * 60_000 }));
      }
    }

    // Maven
    if (fs.exists(p('pom.xml'))) {
      const mvn = fs.exists(p('mvnw')) ? './mvnw' : 'mvn';
      const base = { ecosystem: 'maven' as const, cwd: dir, mayDownload: true, mayModifyFiles: true, requires: `${mvn} + JDK` };
      out.push(cmd({ ...base, label: 'Maven test', category: 'test', argv: [mvn, '-B', 'test'], description: 'Compiles and runs unit tests.', timeoutMs: 30 * 60_000 }));
      out.push(cmd({ ...base, label: 'Maven package', category: 'build', argv: [mvn, '-B', 'package', '-DskipTests'], description: 'Builds the package without running tests.', timeoutMs: 30 * 60_000 }));
    }

    // Node
    const pkgText = fs.read(p('package.json'));
    if (pkgText) {
      let scripts: Record<string, string> = {};
      try {
        scripts = (JSON.parse(pkgText) as { scripts?: Record<string, string> }).scripts ?? {};
      } catch {
        scripts = {};
      }
      const pm = fs.exists(p('pnpm-lock.yaml')) ? 'pnpm' : fs.exists(p('yarn.lock')) ? 'yarn' : fs.exists(p('bun.lockb')) || fs.exists(p('bun.lock')) ? 'bun' : 'npm';
      const run = (s: string) => (pm === 'npm' ? ['npm', 'run', s] : [pm, 'run', s]);
      const base = { ecosystem: 'node' as const, cwd: dir, mayDownload: false, requires: pm };
      const nodeModules = fs.exists(p('node_modules'));
      const scriptCats: [string, CommandCategory, string][] = [
        ['test', 'test', 'Runs the project test script'],
        ['build', 'build', 'Runs the build script (usually writes dist/ or build/)'],
        ['lint', 'lint', 'Runs the lint script'],
        ['typecheck', 'typecheck', 'Runs the typecheck script'],
        ['type-check', 'typecheck', 'Runs the type-check script'],
        ['check', 'check', 'Runs the check script']
      ];
      for (const [name, category, description] of scriptCats) {
        if (!scripts[name]) continue;
        out.push(cmd({ ...base, label: `${pm} ${name}`, category, argv: name === 'test' && pm === 'npm' ? ['npm', 'test'] : run(name), description: `${description}: \`${scripts[name]}\`${nodeModules ? '' : ' (node_modules missing — install dependencies first)'}`, mayModifyFiles: category === 'build' || /--fix|-w\b|--write/.test(scripts[name]!), timeoutMs: 15 * 60_000 }));
      }
      if (!scripts['typecheck'] && !scripts['type-check'] && fs.exists(p('tsconfig.json'))) {
        out.push(cmd({ ...base, label: 'TypeScript typecheck', category: 'typecheck', argv: ['npx', '--no-install', 'tsc', '--noEmit', '-p', 'tsconfig.json'], description: 'Type-checks with the project’s local TypeScript (does not download).', mayModifyFiles: false, requires: 'typescript in node_modules', timeoutMs: 10 * 60_000 }));
      }
    }

    // Python
    const pyproject = fs.read(p('pyproject.toml')) ?? '';
    const isPython = pyproject || fs.exists(p('setup.py')) || fs.exists(p('requirements.txt')) || fs.exists(p('setup.cfg'));
    if (isPython) {
      const venvPy = ['.venv/bin/python', 'venv/bin/python'].find((v) => fs.exists(p(v)));
      const py = venvPy ?? 'python3';
      const base = { ecosystem: 'python' as const, cwd: dir, mayDownload: false, mayModifyFiles: false, requires: venvPy ? `${venvPy} (project virtualenv)` : 'python3' };
      const hasTests = fs.exists(p('tests')) || fs.exists(p('test')) || /\[tool\.pytest/.test(pyproject) || fs.exists(p('pytest.ini'));
      if (hasTests) out.push(cmd({ ...base, label: 'pytest', category: 'test', argv: [py, '-m', 'pytest', '-q'], description: 'Runs the pytest suite.', timeoutMs: 20 * 60_000 }));
      if (/\[tool\.ruff/.test(pyproject) || fs.exists(p('ruff.toml'))) out.push(cmd({ ...base, label: 'ruff check', category: 'lint', argv: [py, '-m', 'ruff', 'check', '.'], description: 'Lints with ruff (no fixes applied).', timeoutMs: 5 * 60_000 }));
      if (/\[tool\.mypy/.test(pyproject) || fs.exists(p('mypy.ini'))) out.push(cmd({ ...base, label: 'mypy', category: 'typecheck', argv: [py, '-m', 'mypy', '.'], description: 'Static type check with mypy.', timeoutMs: 10 * 60_000 }));
      if (/\[tool\.flake8|flake8/.test(pyproject) || fs.exists(p('.flake8'))) out.push(cmd({ ...base, label: 'flake8', category: 'lint', argv: [py, '-m', 'flake8'], description: 'Lints with flake8.', timeoutMs: 5 * 60_000 }));
    }

    // Rust
    if (fs.exists(p('Cargo.toml'))) {
      const base = { ecosystem: 'rust' as const, cwd: dir, mayDownload: true, mayModifyFiles: true, requires: 'cargo' };
      out.push(cmd({ ...base, label: 'cargo test', category: 'test', argv: ['cargo', 'test'], description: 'Builds and runs tests (writes to target/).', timeoutMs: 30 * 60_000 }));
      out.push(cmd({ ...base, label: 'cargo check', category: 'check', argv: ['cargo', 'check', '--all-targets'], description: 'Type-checks all targets without producing binaries.', timeoutMs: 20 * 60_000 }));
      out.push(cmd({ ...base, label: 'cargo clippy', category: 'lint', argv: ['cargo', 'clippy', '--all-targets'], description: 'Runs Clippy lints (requires the clippy component).', timeoutMs: 20 * 60_000 }));
    }

    // Go
    if (fs.exists(p('go.mod'))) {
      const base = { ecosystem: 'go' as const, cwd: dir, mayDownload: true, mayModifyFiles: false, requires: 'go' };
      out.push(cmd({ ...base, label: 'go test', category: 'test', argv: ['go', 'test', './...'], description: 'Runs all package tests.', timeoutMs: 20 * 60_000 }));
      out.push(cmd({ ...base, label: 'go vet', category: 'lint', argv: ['go', 'vet', './...'], description: 'Reports suspicious constructs.', timeoutMs: 10 * 60_000 }));
      out.push(cmd({ ...base, label: 'go build', category: 'build', argv: ['go', 'build', './...'], description: 'Compiles all packages.', timeoutMs: 15 * 60_000 }));
    }

    // Make / CMake
    const makefile = fs.read(p('Makefile'));
    if (makefile) {
      for (const target of ['test', 'check', 'build', 'lint']) {
        if (new RegExp(`^${target}\\s*:`, 'm').test(makefile)) {
          out.push(cmd({ ecosystem: 'make', cwd: dir, label: `make ${target}`, category: target === 'build' ? 'build' : target === 'lint' ? 'lint' : 'test', argv: ['make', target], description: `Runs the Makefile \`${target}\` target (inspect the Makefile: targets can run arbitrary commands).`, mayDownload: false, mayModifyFiles: true, requires: 'make', timeoutMs: 20 * 60_000 }));
        }
      }
    }
    if (fs.exists(p('CMakeLists.txt')) && fs.exists(p('build/CMakeCache.txt'))) {
      out.push(cmd({ ecosystem: 'cmake', cwd: dir, label: 'cmake --build build', category: 'build', argv: ['cmake', '--build', 'build'], description: 'Builds the existing CMake build directory.', mayDownload: false, mayModifyFiles: true, requires: 'cmake', timeoutMs: 30 * 60_000 }));
      out.push(cmd({ ecosystem: 'cmake', cwd: dir, label: 'ctest', category: 'test', argv: ['ctest', '--test-dir', 'build', '--output-on-failure'], description: 'Runs CTest in the build directory.', mayDownload: false, mayModifyFiles: false, requires: 'ctest', timeoutMs: 30 * 60_000 }));
    }
  }
  return out;
}

// ------------------------------------------------------------------ custom command safety

export interface CommandSafety {
  ok: boolean;
  argv: string[];
  errors: string[];
  warnings: string[];
}

const FORBIDDEN_BINARIES = new Set(['sudo', 'su', 'doas', 'pkexec', 'run0', 'mkfs', 'dd', 'shutdown', 'reboot', 'poweroff', 'systemctl', 'chown', 'passwd', 'useradd', 'userdel', 'mount', 'umount', 'fdisk', 'parted', 'wipefs', 'shred']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'eval', 'exec', 'xargs', 'env', 'nohup', 'setsid']);

/** Splits a command line like a POSIX shell would for simple words and quotes; rejects shell syntax. */
export function splitCommandLine(line: string): { argv: string[]; error?: string } {
  const argv: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) argv.push(cur);
      cur = '';
      has = false;
      continue;
    }
    if (';&|<>`$(){}\n'.includes(c)) return { argv: [], error: `Shell syntax “${c}” is not allowed. RepoMind runs commands directly (no shell): pipes, redirects, chaining and substitutions are rejected.` };
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
      continue;
    }
    cur += c;
    has = true;
  }
  if (quote) return { argv: [], error: 'Unterminated quote.' };
  if (has) argv.push(cur);
  return { argv };
}

/** Validates a user-entered command. Never used for commands suggested by DeepSeek without user review. */
export function checkCustomCommand(line: string): CommandSafety {
  const { argv, error } = splitCommandLine(line.trim());
  const errors: string[] = [];
  const warnings: string[] = [];
  if (error) errors.push(error);
  if (!error && argv.length === 0) errors.push('Empty command.');
  const bin = (argv[0] ?? '').split('/').pop() ?? '';
  if (FORBIDDEN_BINARIES.has(bin)) errors.push(`“${bin}” is never run by RepoMind (privileged or system-level command).`);
  if (SHELLS.has(bin)) errors.push(`“${bin}” would run arbitrary shell code; run the underlying tool directly instead.`);
  if (bin === 'rm' || bin === 'rmdir' || bin === 'unlink') errors.push('File deletion commands are blocked. Delete files yourself if needed.');
  if (bin === 'git') {
    const sub = argv[1];
    if (['push', 'reset', 'clean', 'checkout', 'restore', 'rebase', 'filter-branch', 'gc', 'prune', 'reflog', 'update-ref', 'branch', 'tag', 'remote', 'config', 'commit', 'merge', 'cherry-pick', 'stash', 'switch', 'rm', 'mv', 'apply', 'am'].includes(sub ?? '')) {
      errors.push(`“git ${sub}” changes repository state; use RepoMind’s patch / checkpoint features instead.`);
    }
  }
  if (bin === 'curl' || bin === 'wget') warnings.push('Downloads content from the network.');
  if (bin === 'chmod') warnings.push('Changes file permissions.');
  if (argv.some((a) => a === '-rf' || a === '-fr' || a === '--force')) warnings.push('Uses a force flag.');
  if (argv.some((a) => a.startsWith('/') && !a.startsWith('/tmp'))) warnings.push('References an absolute path outside the project.');
  return { ok: errors.length === 0, argv, errors, warnings };
}
