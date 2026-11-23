import { describe, expect, it } from 'vitest';
import { RepoGraph } from '@repomind/core';
import { indexed, loadFixture, memoryRepo } from './helpers.js';

describe('local scanning rules (fixture)', () => {
  it('respects .gitignore and excludes secret files', () => {
    const { files, skipped } = loadFixture('android-notes');
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('local.properties');
    expect(skipped.find((s) => s.path === 'local.properties')?.reason).toMatch(/ignored|secret-file/);
    expect(paths).toContain('app/src/main/java/com/example/notes/MainActivity.kt');
  });
});

describe('repository index — Android fixture', () => {
  const { index } = indexed('android-notes');
  const graph = new RepoGraph(index);

  it('detects Gradle modules with Android types and module dependencies', () => {
    const app = index.modules.find((m) => m.id === ':app');
    const data = index.modules.find((m) => m.id === ':core:data');
    expect(app?.android?.type).toBe('application');
    expect(app?.android?.namespace).toBe('com.example.notes');
    expect(app?.dependsOn).toEqual([':core:data']);
    expect(data?.android?.type).toBe('library');
    expect(data?.externalDeps.some((d) => d.includes('androidx.room:room-runtime:2.6.1'))).toBe(true);
  });

  it('maps files to modules', () => {
    expect(index.files['core/data/src/main/java/com/example/notes/data/Note.kt']?.module).toBe(':core:data');
    expect(index.files['app/src/main/java/com/example/notes/MainActivity.kt']?.module).toBe(':app');
  });

  it('resolves Kotlin imports across modules', () => {
    const deps = graph.dependencies('app/src/main/java/com/example/notes/ui/NotesViewModel.kt');
    expect(deps).toContain('core/data/src/main/java/com/example/notes/data/NoteRepository.kt');
    expect(deps).toContain('core/data/src/main/java/com/example/notes/data/Note.kt');
  });

  it('adds implicit same-package edges (Kotlin needs no import within a package)', () => {
    const deps = graph.dependencies('core/data/src/main/java/com/example/notes/data/NoteRepository.kt');
    expect(deps).toContain('core/data/src/main/java/com/example/notes/data/NoteDao.kt');
  });

  it('links ViewBinding and R references to layout resources', () => {
    const main = graph.dependencies('app/src/main/java/com/example/notes/MainActivity.kt', ['resource']);
    expect(main).toContain('app/src/main/res/layout/activity_main.xml');
    const settings = graph.dependencies('app/src/main/java/com/example/notes/settings/SettingsActivity.kt', ['resource']);
    expect(settings).toEqual(expect.arrayContaining(['app/src/main/res/layout/activity_settings.xml', 'app/src/main/res/values/strings.xml']));
  });

  it('links tests to their subjects', () => {
    expect(graph.testsFor('app/src/main/java/com/example/notes/ui/NotesViewModel.kt')).toContain('app/src/test/java/com/example/notes/ui/NotesViewModelTest.kt');
  });

  it('finds entry points from the manifest', () => {
    const launcher = index.entryPoints.find((e) => e.kind === 'android-launcher-activity');
    expect(launcher?.path).toBe('app/src/main/java/com/example/notes/MainActivity.kt');
    expect(index.entryPoints.some((e) => e.kind === 'android-activity' && e.detail === 'com.example.notes.settings.SettingsActivity')).toBe(true);
  });

  it('classifies symbols and builds the symbol index', () => {
    expect(index.symbolIndex['Note']?.[0]?.kind).toBe('entity');
    expect(index.symbolIndex['NoteDao']?.[0]?.kind).toBe('dao');
    expect(index.symbolIndex['MainActivity']?.[0]?.kind).toBe('activity');
    expect(index.symbolIndex['NotesViewModel']?.[0]?.kind).toBe('viewmodel');
  });

  it('builds config map, stack facts, stats and limitations', () => {
    expect(index.config.some((c) => c.kind === 'version-catalog')).toBe(true);
    expect(index.config.some((c) => c.kind === 'android-manifest')).toBe(true);
    expect(index.stack).toEqual(expect.arrayContaining(['Android application (Android Gradle Plugin)', 'Room (SQLite persistence)']));
    expect(index.stats.byLanguage['kotlin']?.files).toBeGreaterThan(5);
    expect(index.limitations.some((l) => /lexical/.test(l))).toBe(true);
    expect(index.limitations.some((l) => /Generated code/.test(l))).toBe(true);
  });

  it('flags prompt-injection text in repository files', () => {
    expect(index.files['README.md']?.injectionFindings.length).toBeGreaterThan(0);
  });
});

describe('repository index — TypeScript fixture', () => {
  const { index } = indexed('ts-shop');
  const graph = new RepoGraph(index);
  it('resolves relative imports including extensionless and index files', () => {
    expect(graph.dependencies('src/cart/cart.ts')).toEqual(expect.arrayContaining(['src/cart/pricing.ts', 'src/api/client.ts']));
    expect(graph.dependents('src/cart/pricing.ts')).toEqual(expect.arrayContaining(['src/cart/cart.ts', 'src/ui/CartView.tsx', 'src/index.ts', 'test/pricing.test.ts']));
  });
  it('marks third-party imports as external', () => {
    expect(index.files['src/cart/cart.ts']?.imports.every((i) => !i.external)).toBe(true);
    expect(index.files['test/cart.test.ts']?.imports.find((i) => i.spec === 'vitest')?.external).toBe(true);
  });
  it('detects the npm package as a module with scripts', () => {
    expect(index.modules[0]).toMatchObject({ id: 'ts-shop', kind: 'npm' });
    expect(index.config.find((c) => c.kind === 'package-json')?.summary).toMatch(/test/);
  });
});

describe('cross-language resolution', () => {
  it('python relative and absolute imports', () => {
    const { index } = memoryRepo({
      'app/__init__.py': '',
      'app/models.py': 'class User:\n    pass\n',
      'app/service.py': 'from .models import User\nfrom app import models\nimport requests\n',
      'tests/test_service.py': 'from app.service import run\n'
    });
    const g = new RepoGraph(index);
    expect(g.dependencies('app/service.py')).toContain('app/models.py');
    expect(index.files['app/service.py']?.imports.find((i) => i.spec === 'requests')?.external).toBe(true);
    expect(g.dependencies('tests/test_service.py')).toContain('app/service.py');
  });
  it('rust mod/use and go module imports', () => {
    const { index } = memoryRepo({
      'Cargo.toml': '[package]\nname = "x"\n',
      'src/main.rs': 'mod config;\nuse crate::config::Settings;\nfn main() {}\n',
      'src/config.rs': 'pub struct Settings;\n',
      'go.mod': 'module example.com/app\n\ngo 1.22\n',
      'cmd/main.go': 'package main\n\nimport "example.com/app/internal/srv"\n\nfunc main() { srv.Run() }\n',
      'internal/srv/srv.go': 'package srv\n\nfunc Run() {}\n'
    });
    const g = new RepoGraph(index);
    expect(g.dependencies('src/main.rs')).toContain('src/config.rs');
    expect(g.dependencies('cmd/main.go')).toContain('internal/srv/srv.go');
    expect(index.entryPoints.some((e) => e.path === 'src/main.rs')).toBe(true);
  });
  it('reports unresolved internal imports as a limitation', () => {
    const { index } = memoryRepo({ 'src/a.ts': "import { x } from './missing';\n" });
    expect(index.files['src/a.ts']?.imports[0]?.unresolved).toBe(true);
    expect(index.limitations.some((l) => /could not be resolved/.test(l))).toBe(true);
  });
  it('detects secrets inside indexed files without storing their values', () => {
    const fakeKey = 'ghp_' + 'A'.repeat(36);
    const { index } = memoryRepo({ 'src/config.ts': `export const token = "${fakeKey}";\n` });
    const f = index.files['src/config.ts']!.secretFindings[0]!;
    expect(f.type).toBe('github-token');
    expect(JSON.stringify(index)).not.toContain(fakeKey);
  });
});
