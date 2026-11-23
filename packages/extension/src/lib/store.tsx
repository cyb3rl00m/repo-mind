import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Retriever,
  createMemory,
  parseGitHubUrl,
  refreshVerifiedFacts,
  type EngineeringMode,
  type IngestOptions,
  type ProjectMemory,
  type PublishFile,
  type PublishResult,
  type PromptStage,
  type RepoIndex,
  type SkippedFile,
  type SourceFile,
  type WorkflowTask
} from '@repomind/core';
import { db } from './db';
import { engine, type EngineState } from './engine';
import { importViaBrowser } from './github';
import { indexInWorker } from './indexing';
import { loadHandle, pickBrowserFolder, scanBrowserFolder, storeHandle } from './localFolder';
import { DEFAULT_SETTINGS, identityOf, type Activity, type Project, type Settings } from './types';
import { rid } from './util';

export type Screen = 'dashboard' | 'repos' | 'explorer' | 'brain' | 'context' | 'workflow' | 'builder' | 'patch' | 'build' | 'memory' | 'settings';

export interface ActiveData {
  project: Project;
  files: SourceFile[];
  index: RepoIndex;
  contents: Map<string, string>;
  memory: ProjectMemory;
  tasks: WorkflowTask[];
}

export interface ContextDraft {
  task: string;
  mode: EngineeringMode;
  stage: PromptStage;
  include: string[];
  exclude: string[];
  criteria: string;
}

export interface PatchDraft {
  diff: string;
  taskId?: string;
  source: 'deepseek' | 'manual';
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  text: string;
}

interface Snapshot {
  files: SourceFile[];
  skipped: SkippedFile[];
}

interface StoreValue {
  ready: boolean;
  projects: Project[];
  active: ActiveData | null;
  activeLoading: boolean;
  engineState: EngineState;
  settings: Settings;
  activity: Activity[];
  screen: Screen;
  busy: { label: string; detail?: string } | null;
  toasts: Toast[];
  contextDraft: ContextDraft;
  patchDraft: PatchDraft | null;
  focusFile: string | null;
  activeTaskId: string | null;
  retriever: Retriever | null;
  setScreen(s: Screen): void;
  setFocusFile(p: string | null): void;
  setContextDraft(d: Partial<ContextDraft>): void;
  setPatchDraft(d: PatchDraft | null): void;
  setActiveTaskId(id: string | null): void;
  toast(text: string, kind?: Toast['kind']): void;
  log(kind: Activity['kind'], text: string): void;
  connectEngine(): Promise<void>;
  importGithub(input: { url: string; ref?: string; usePrivate: boolean; viaEngine: boolean }): Promise<void>;
  importLocalEngine(path?: string): Promise<void>;
  importBrowserFolder(): Promise<void>;
  reindex(projectId: string, opts?: { ref?: string }): Promise<void>;
  openProject(projectId: string): Promise<void>;
  removeProject(projectId: string): Promise<void>;
  updateProject(projectId: string, patch: Partial<Project>): Promise<void>;
  saveMemory(mem: ProjectMemory): Promise<void>;
  saveTask(task: WorkflowTask): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  wipeAll(): Promise<void>;
  registerWorktree(project: { id: string; root: string; name: string; worktreeOf?: string }): Promise<void>;
  /** Applies files just published to GitHub to the local snapshot and re-indexes (no re-download). */
  applyPublished(projectId: string, changes: PublishFile[], result: PublishResult): Promise<void>;
}

const Ctx = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('StoreProvider missing');
  return v;
}

export function useActive(): ActiveData {
  const a = useStore().active;
  if (!a) throw new Error('No active project');
  return a;
}

function ingestOpts(s: Settings): IngestOptions {
  return { extraExclusions: s.extraExclusions, maxFileBytes: s.maxFileKb * 1024, maxFiles: s.maxFiles };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<ActiveData | null>(null);
  const [activeLoading, setActiveLoading] = useState(false);
  const [engineState, setEngineState] = useState<EngineState>(engine.state);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [busy, setBusy] = useState<{ label: string; detail?: string } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [contextDraft, setDraft] = useState<ContextDraft>({ task: '', mode: 'implementation', stage: 'understand', include: [], exclude: [], criteria: '' });
  const [patchDraft, setPatchDraft] = useState<PatchDraft | null>(null);
  const [focusFile, setFocusFile] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const activeRef = useRef(active);
  activeRef.current = active;

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const t = { id: rid('t'), kind, text };
    setToasts((x) => [...x.slice(-3), t]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== t.id)), kind === 'error' ? 9000 : 4500);
  }, []);

  const log = useCallback((kind: Activity['kind'], text: string) => {
    const a: Activity = { id: rid('a'), at: new Date().toISOString(), projectId: activeRef.current?.project.id, kind, text };
    setActivity((x) => [a, ...x].slice(0, 200));
    void db.put('activity', a.id, a);
  }, []);

  const persistProject = useCallback(async (p: Project) => {
    await db.put('projects', p.id, p);
    setProjects((xs) => {
      const i = xs.findIndex((x) => x.id === p.id);
      if (i < 0) return [p, ...xs];
      const copy = [...xs];
      copy[i] = p;
      return copy;
    });
    setActive((a) => (a && a.project.id === p.id ? { ...a, project: p } : a));
  }, []);

  // Boot.
  useEffect(() => {
    void (async () => {
      const [ps, s, acts] = await Promise.all([db.all<Project>('projects'), db.get<Settings>('kv', 'settings'), db.all<Activity>('activity')]);
      const merged = { ...DEFAULT_SETTINGS, ...(s ?? {}) };
      setSettings(merged);
      document.documentElement.dataset['theme'] = merged.theme;
      setProjects(ps.sort((a, b) => (b.indexedAt ?? b.createdAt).localeCompare(a.indexedAt ?? a.createdAt)));
      setActivity(acts.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200));
      const lastActive = await db.get<string>('kv', 'activeProject');
      setReady(true);
      if (merged.autoConnectEngine) void engine.connect();
      if (lastActive && ps.some((p) => p.id === lastActive && p.status === 'ready')) void openProjectInner(lastActive);
    })();
    return engine.subscribe(setEngineState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openProjectInner = useCallback(async (projectId: string) => {
    // Read from the database: the in-memory list may not have re-rendered after a just-finished index.
    const project = (await db.get<Project>('projects', projectId)) ?? projectsRef.current.find((p) => p.id === projectId);
    if (!project) return;
    setActiveLoading(true);
    try {
      const [snap, index, mem, tasks] = await Promise.all([
        db.get<Snapshot>('snapshots', projectId),
        db.get<RepoIndex>('indexes', projectId),
        db.get<ProjectMemory>('memory', projectId),
        db.all<WorkflowTask>('tasks')
      ]);
      if (!snap || !index) {
        setActive(null);
        return;
      }
      setActive({
        project,
        files: snap.files,
        index,
        contents: new Map(snap.files.map((f) => [f.path, f.content])),
        memory: mem ?? createMemory(),
        tasks: tasks.filter((t) => t.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      });
      await db.put('kv', 'activeProject', projectId);
    } finally {
      setActiveLoading(false);
    }
  }, []);

  /** Shared pipeline: files -> index (worker) -> verified memory -> persist -> activate. */
  const finishIndexing = useCallback(
    async (project: Project, files: SourceFile[], skipped: SkippedFile[]) => {
      setBusy({ label: `Indexing ${project.name}`, detail: `${files.length} files` });
      const index = await indexInWorker(files, skipped, (done, total) => setBusy({ label: `Indexing ${project.name}`, detail: `${done}/${total} files` }));
      const prevMem = (await db.get<ProjectMemory>('memory', project.id)) ?? createMemory();
      const memory = refreshVerifiedFacts(prevMem, index, identityOf(project));
      const updated: Project = {
        ...project,
        status: 'ready',
        error: undefined,
        indexedAt: new Date().toISOString(),
        stats: { files: index.stats.indexedFiles, lines: index.stats.totalLines, skipped: index.stats.skippedFiles, tokens: Object.values(index.files).reduce((a, f) => a + f.tokensEstimate, 0) }
      };
      await db.put('snapshots', project.id, { files, skipped } satisfies Snapshot);
      await db.put('indexes', project.id, index);
      await db.put('memory', project.id, memory);
      await persistProject(updated);
      log('index', `Indexed ${project.name}: ${index.stats.indexedFiles} files, ${index.edges.length} dependency edges`);
      await openProjectInner(project.id);
    },
    [log, openProjectInner, persistProject]
  );

  const withBusy = useCallback(
    async (label: string, fn: () => Promise<void>, project?: Project) => {
      setBusy({ label });
      try {
        await fn();
      } catch (e) {
        const msg = (e as Error).message;
        toast(msg, 'error');
        log('error', `${label}: ${msg}`);
        if (project) await persistProject({ ...project, status: 'error', error: msg });
      } finally {
        setBusy(null);
      }
    },
    [log, persistProject, toast]
  );

  const fetchGithub = useCallback(async (project: Project, ref?: string) => {
    const g = project.github!;
    const opts = ingestOpts(settingsRef.current);
    const progress = (m: string) => setBusy({ label: `Importing ${g.owner}/${g.repo}`, detail: m });
    if (g.viaEngine) {
      return engine.call('github.fetch', { owner: g.owner, repo: g.repo, ref: ref ?? g.ref, subPath: g.subPath, useToken: g.private, options: opts }, { onEvent: (e) => e.data.message && progress(e.data.message) });
    }
    return importViaBrowser(g.owner, g.repo, ref ?? g.ref, { ...opts, subPath: g.subPath, useSessionToken: g.private }, progress);
  }, []);

  const importGithub = useCallback<StoreValue['importGithub']>(
    async ({ url, ref, usePrivate, viaEngine }) => {
      const parsed = parseGitHubUrl(url);
      if (!parsed) {
        toast('Not a valid GitHub repository URL.', 'error');
        return;
      }
      const id = `gh_${parsed.owner}_${parsed.repo}${parsed.subPath ? `_${parsed.subPath.replace(/\W+/g, '_')}` : ''}`.toLowerCase();
      const existing = projectsRef.current.find((p) => p.id === id);
      const project: Project = existing ?? {
        id,
        name: `${parsed.owner}/${parsed.repo}${parsed.subPath ? `/${parsed.subPath}` : ''}`,
        source: 'github',
        github: { owner: parsed.owner, repo: parsed.repo, ref: ref || parsed.ref || '', sha: '', private: usePrivate, viaEngine, subPath: parsed.subPath, branches: [] },
        createdAt: new Date().toISOString(),
        status: 'new',
        pinnedInclude: [],
        pinnedExclude: []
      };
      project.github = { ...project.github!, private: usePrivate, viaEngine, ref: ref || parsed.ref || project.github!.ref };
      await withBusy(
        `Importing ${project.name}`,
        async () => {
          await persistProject({ ...project, status: 'indexing' });
          const r = await fetchGithub(project, project.github!.ref || undefined);
          const updated: Project = { ...project, github: { ...project.github!, ref: r.ref, sha: r.commit.sha, private: r.meta.private || usePrivate, branches: r.branches.map((b) => b.name), commitMessage: r.commit.message, empty: r.empty } };
          log('import', r.empty ? `Imported empty repository ${project.name}` : `Imported ${project.name} @ ${r.ref} (${r.commit.sha.slice(0, 10)})`);
          await finishIndexing(updated, r.files, r.skipped);
          toast(r.empty ? `${project.name} is empty — use GitHub Builder to create the first files.` : `Imported ${project.name}`, 'success');
        },
        project
      );
    },
    [fetchGithub, finishIndexing, log, persistProject, toast, withBusy]
  );

  const scanEngineProject = useCallback(async (project: Project) => {
    const pid = project.engine!.projectId;
    const progress = (m: string) => setBusy({ label: `Scanning ${project.name}`, detail: m });
    const [scan, info] = await Promise.all([
      engine.call('project.scan', { projectId: pid, options: ingestOpts(settingsRef.current) }, { onEvent: (e) => e.data.message && progress(e.data.message) }),
      engine.call('git.info', { projectId: pid })
    ]);
    const updated: Project = { ...project, engine: { ...project.engine!, branch: info.branch, head: info.head, dirty: info.dirty.length } };
    return { updated, scan };
  }, []);

  const importLocalEngine = useCallback<StoreValue['importLocalEngine']>(
    async (path) => {
      await withBusy('Opening local folder', async () => {
        if (engine.state.status !== 'connected') await engine.connect();
        if (engine.state.status !== 'connected') throw new Error('Local engine is not connected. Install it (scripts/install.sh) or use “Browser folder (read-only)”.');
        let chosen = path?.trim();
        if (!chosen) {
          const picked = await engine.call('project.pickFolder', { title: 'Open project in RepoMind' });
          if (!picked.picker) throw new Error('No folder picker available (install kdialog or zenity). Type the absolute path instead.');
          if (!picked.path) return;
          chosen = picked.path;
        }
        const ep = await engine.call('project.register', { path: chosen });
        const id = `local_${ep.id}`;
        const existing = projectsRef.current.find((p) => p.id === id);
        const project: Project = existing ?? { id, name: ep.name, source: 'local-engine', engine: { projectId: ep.id, root: ep.root, worktreeOf: ep.worktreeOf }, createdAt: new Date().toISOString(), status: 'indexing', pinnedInclude: [], pinnedExclude: [] };
        await persistProject({ ...project, status: 'indexing' });
        const { updated, scan } = await scanEngineProject(project);
        log('import', `Opened local folder ${ep.root}`);
        await finishIndexing(updated, scan.files, scan.skipped);
        toast(`Indexed ${ep.name}`, 'success');
      });
    },
    [finishIndexing, log, persistProject, scanEngineProject, toast, withBusy]
  );

  const registerWorktree = useCallback<StoreValue['registerWorktree']>(
    async (ep) => {
      const id = `local_${ep.id}`;
      const project: Project = { id, name: `${ep.name} (worktree)`, source: 'local-engine', engine: { projectId: ep.id, root: ep.root, worktreeOf: ep.worktreeOf }, createdAt: new Date().toISOString(), status: 'indexing', pinnedInclude: [], pinnedExclude: [] };
      await withBusy('Indexing worktree', async () => {
        await persistProject(project);
        const { updated, scan } = await scanEngineProject(project);
        await finishIndexing(updated, scan.files, scan.skipped);
      });
    },
    [finishIndexing, persistProject, scanEngineProject, withBusy]
  );

  const importBrowserFolder = useCallback(async () => {
    let handle;
    try {
      handle = await pickBrowserFolder();
    } catch {
      return; // cancelled
    }
    const id = rid('fs');
    const project: Project = { id, name: handle.name, source: 'local-browser', browser: { handleKey: id }, createdAt: new Date().toISOString(), status: 'indexing', pinnedInclude: [], pinnedExclude: [] };
    await withBusy(
      `Reading ${handle.name}`,
      async () => {
        await storeHandle(id, handle);
        await persistProject(project);
        const r = await scanBrowserFolder(handle, ingestOpts(settingsRef.current), (n) => setBusy({ label: `Reading ${handle.name}`, detail: `${n} files` }));
        log('import', `Read browser folder ${handle.name} (read-only)`);
        await finishIndexing(project, r.files, r.skipped);
      },
      project
    );
  }, [finishIndexing, log, persistProject, withBusy]);

  const reindex = useCallback<StoreValue['reindex']>(
    async (projectId, opts = {}) => {
      const project = projectsRef.current.find((p) => p.id === projectId);
      if (!project) return;
      await withBusy(
        `Refreshing ${project.name}`,
        async () => {
          await persistProject({ ...project, status: 'indexing' });
          if (project.source === 'github') {
            const r = await fetchGithub(project, opts.ref);
            const updated: Project = { ...project, github: { ...project.github!, ref: r.ref, sha: r.commit.sha, branches: r.branches.map((b) => b.name), commitMessage: r.commit.message, empty: r.empty } };
            await finishIndexing(updated, r.files, r.skipped);
          } else if (project.source === 'local-engine') {
            if (engine.state.status !== 'connected') await engine.connect();
            const { updated, scan } = await scanEngineProject(project);
            await finishIndexing(updated, scan.files, scan.skipped);
          } else {
            const h = await loadHandle(project.browser!.handleKey);
            if (!h) throw new Error('Folder permission was not granted. Re-import the folder.');
            const r = await scanBrowserFolder(h, ingestOpts(settingsRef.current), () => {});
            await finishIndexing(project, r.files, r.skipped);
          }
          toast(`Refreshed ${project.name}`, 'success');
        },
        project
      );
    },
    [fetchGithub, finishIndexing, persistProject, scanEngineProject, toast, withBusy]
  );

  const removeProject = useCallback(async (projectId: string) => {
    const p = projectsRef.current.find((x) => x.id === projectId);
    for (const s of ['projects', 'snapshots', 'indexes', 'memory'] as const) await db.del(s, projectId);
    for (const t of await db.all<WorkflowTask>('tasks')) if (t.projectId === projectId) await db.del('tasks', t.id);
    if (p?.engine && engine.state.status === 'connected') await engine.call('project.forget', { projectId: p.engine.projectId }).catch(() => undefined);
    setProjects((xs) => xs.filter((x) => x.id !== projectId));
    setActive((a) => (a?.project.id === projectId ? null : a));
  }, []);

  const updateProject = useCallback(async (projectId: string, patch: Partial<Project>) => {
    const p = projectsRef.current.find((x) => x.id === projectId);
    if (p) await persistProject({ ...p, ...patch });
  }, [persistProject]);

  const saveMemory = useCallback(async (mem: ProjectMemory) => {
    const a = activeRef.current;
    if (!a) return;
    await db.put('memory', a.project.id, mem);
    setActive({ ...a, memory: mem });
  }, []);

  const saveTask = useCallback(async (task: WorkflowTask) => {
    const t = { ...task, updatedAt: new Date().toISOString() };
    await db.put('tasks', t.id, t);
    setActive((a) => (a && a.project.id === t.projectId ? { ...a, tasks: [t, ...a.tasks.filter((x) => x.id !== t.id)] } : a));
  }, []);

  const deleteTask = useCallback(async (taskId: string) => {
    await db.del('tasks', taskId);
    setActive((a) => (a ? { ...a, tasks: a.tasks.filter((x) => x.id !== taskId) } : a));
  }, []);

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    setSettings(next);
    document.documentElement.dataset['theme'] = next.theme;
    await db.put('kv', 'settings', next);
  }, []);

  const wipeAll = useCallback(async () => {
    await db.wipe();
    if (chrome.storage?.session) await chrome.storage.session.clear();
    setProjects([]);
    setActive(null);
    setActivity([]);
    setSettings(DEFAULT_SETTINGS);
  }, []);

  const applyPublished = useCallback<StoreValue['applyPublished']>(
    async (projectId, changes, result) => {
      const project = (await db.get<Project>('projects', projectId)) ?? projectsRef.current.find((p) => p.id === projectId);
      if (!project?.github) return;
      await withBusy('Updating local snapshot', async () => {
        const snap = (await db.get<Snapshot>('snapshots', projectId)) ?? { files: [], skipped: [] };
        const byPath = new Map(snap.files.map((f) => [f.path, f]));
        for (const c of changes) {
          if (c.content === null) byPath.delete(c.path);
          else byPath.set(c.path, { path: c.path, content: c.content, size: new TextEncoder().encode(c.content).length });
        }
        const branches = project.github!.branches.includes(result.branch) ? project.github!.branches : [...project.github!.branches, result.branch];
        const updated: Project = { ...project, github: { ...project.github!, ref: result.branch, sha: result.commitSha, branches, empty: false, commitMessage: 'published by RepoMind' } };
        log('patch', `Published ${changes.length} file(s) to ${project.name}@${result.branch} (${result.commitSha.slice(0, 10)})`);
        await finishIndexing(updated, [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)), snap.skipped);
      });
    },
    [finishIndexing, log, withBusy]
  );

  const retriever = useMemo(() => (active ? new Retriever(active.index, active.contents) : null), [active?.index, active?.contents]); // eslint-disable-line react-hooks/exhaustive-deps

  const value: StoreValue = {
    ready,
    projects,
    active,
    activeLoading,
    engineState,
    settings,
    activity,
    screen,
    busy,
    toasts,
    contextDraft,
    patchDraft,
    focusFile,
    activeTaskId,
    retriever,
    setScreen,
    setFocusFile,
    setContextDraft: (d) => setDraft((x) => ({ ...x, ...d })),
    setPatchDraft,
    setActiveTaskId,
    toast,
    log,
    connectEngine: async () => {
      await engine.connect();
    },
    importGithub,
    importLocalEngine,
    importBrowserFolder,
    reindex,
    openProject: openProjectInner,
    removeProject,
    updateProject,
    saveMemory,
    saveTask,
    deleteTask,
    updateSettings,
    wipeAll,
    registerWorktree,
    applyPublished
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

