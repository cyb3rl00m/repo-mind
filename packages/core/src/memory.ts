import type { RepoIdentity, RepoIndex } from './types.js';

export type MemoryCategory =
  | 'objective'
  | 'architecture'
  | 'stack'
  | 'convention'
  | 'dependency'
  | 'decision'
  | 'known-bug'
  | 'completed-task'
  | 'outstanding-task'
  | 'limitation'
  | 'constraint';

/**
 * - verified:  derived from the repository index by RepoMind (regenerated on re-index)
 * - approved:  written or approved by the user (never overwritten automatically)
 * - suggested: proposed by DeepSeek or heuristics; excluded from prompts until approved
 */
export type Provenance = 'verified' | 'approved' | 'suggested';

export interface MemoryVersion {
  version: number;
  text: string;
  provenance: Provenance;
  at: string;
  by: string;
}

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  text: string;
  provenance: Provenance;
  source: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: MemoryVersion[];
  archived: boolean;
}

export interface ProjectMemory {
  schema: 1;
  revision: number;
  updatedAt: string;
  entries: MemoryEntry[];
}

export const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  objective: 'Project objectives',
  architecture: 'Architecture',
  stack: 'Technical stack',
  convention: 'Development conventions',
  dependency: 'Important dependencies',
  decision: 'Decisions',
  'known-bug': 'Known bugs',
  'completed-task': 'Completed tasks',
  'outstanding-task': 'Outstanding tasks',
  limitation: 'Known limitations',
  constraint: 'Implementation constraints'
};

export const MEMORY_FILES: Record<string, MemoryCategory[]> = {
  'PROJECT_CONTEXT.md': ['objective', 'stack', 'constraint', 'convention'],
  'ARCHITECTURE.md': ['architecture', 'dependency'],
  'DEVELOPMENT_STATUS.md': ['completed-task', 'outstanding-task'],
  'DECISIONS.md': ['decision'],
  'KNOWN_ISSUES.md': ['known-bug', 'limitation']
};

let idCounter = 0;
export function newId(prefix = 'm'): string {
  idCounter = (idCounter + 1) % 1_000_000;
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

export function createMemory(): ProjectMemory {
  return { schema: 1, revision: 0, updatedAt: new Date().toISOString(), entries: [] };
}

function bump(mem: ProjectMemory, entries: MemoryEntry[]): ProjectMemory {
  return { ...mem, entries, revision: mem.revision + 1, updatedAt: new Date().toISOString() };
}

export function addEntry(
  mem: ProjectMemory,
  input: { category: MemoryCategory; text: string; provenance: Provenance; source: string }
): ProjectMemory {
  const text = input.text.trim();
  if (!text) return mem;
  const now = new Date().toISOString();
  const dup = mem.entries.find((e) => !e.archived && e.category === input.category && e.text.toLowerCase() === text.toLowerCase());
  if (dup) return mem;
  const entry: MemoryEntry = {
    id: newId(),
    category: input.category,
    text,
    provenance: input.provenance,
    source: input.source,
    createdAt: now,
    updatedAt: now,
    version: 1,
    history: [{ version: 1, text, provenance: input.provenance, at: now, by: input.source }],
    archived: false
  };
  return bump(mem, [...mem.entries, entry]);
}

/** User edit: keeps history; a user-edited entry becomes `approved` (the user is now its author). */
export function updateEntry(mem: ProjectMemory, id: string, text: string, by = 'user'): ProjectMemory {
  const now = new Date().toISOString();
  return bump(
    mem,
    mem.entries.map((e) => {
      if (e.id !== id || e.text === text.trim()) return e;
      const version = e.version + 1;
      const provenance: Provenance = by === 'user' ? 'approved' : e.provenance;
      return { ...e, text: text.trim(), provenance, version, updatedAt: now, history: [...e.history, { version, text: text.trim(), provenance, at: now, by }] };
    })
  );
}

/** Promotes a suggestion to an approved fact. Only an explicit user action should call this. */
export function approveEntry(mem: ProjectMemory, id: string): ProjectMemory {
  const now = new Date().toISOString();
  return bump(
    mem,
    mem.entries.map((e) =>
      e.id === id && e.provenance !== 'approved'
        ? { ...e, provenance: 'approved', version: e.version + 1, updatedAt: now, history: [...e.history, { version: e.version + 1, text: e.text, provenance: 'approved', at: now, by: 'user' }] }
        : e
    )
  );
}

export function archiveEntry(mem: ProjectMemory, id: string, archived = true): ProjectMemory {
  return bump(mem, mem.entries.map((e) => (e.id === id ? { ...e, archived, updatedAt: new Date().toISOString() } : e)));
}

export function revertEntry(mem: ProjectMemory, id: string, version: number): ProjectMemory {
  const e = mem.entries.find((x) => x.id === id);
  const v = e?.history.find((h) => h.version === version);
  if (!e || !v) return mem;
  return updateEntry(mem, id, v.text, 'user');
}

/** Facts derived from the index. Regenerated on every re-index; never touches approved/suggested entries. */
export function deriveVerifiedFacts(index: RepoIndex, identity: RepoIdentity): { category: MemoryCategory; text: string }[] {
  const facts: { category: MemoryCategory; text: string }[] = [];
  facts.push({ category: 'architecture', text: `Repository ${identity.name}${identity.branch ? ` on branch ${identity.branch}` : ''}${identity.commit ? ` @ ${identity.commit.slice(0, 10)}` : ''}: ${index.stats.indexedFiles} indexed files, ${index.stats.totalLines} lines.` });
  for (const s of index.stack) facts.push({ category: 'stack', text: s });
  const realModules = index.modules.filter((m) => m.kind !== 'directory');
  if (realModules.length) {
    for (const m of realModules.slice(0, 30)) {
      const android = m.android ? ` (Android ${m.android.type}${m.android.namespace ? `, namespace ${m.android.namespace}` : ''})` : '';
      facts.push({ category: 'architecture', text: `Module ${m.id}${android} at \`${m.root || '.'}\`, ${m.fileCount} files${m.dependsOn.length ? `, depends on ${m.dependsOn.join(', ')}` : ''}.` });
    }
  } else if (index.modules.length) {
    facts.push({ category: 'architecture', text: `Top-level directories: ${index.modules.map((m) => `${m.id} (${m.fileCount})`).slice(0, 15).join(', ')}.` });
  }
  const launchers = index.entryPoints.filter((e) => e.kind === 'android-launcher-activity');
  for (const l of launchers) facts.push({ category: 'architecture', text: `Launcher activity: ${l.detail} (\`${l.path}\`).` });
  const mains = index.entryPoints.filter((e) => ['main-function', 'package-main', 'package-bin', 'python-main'].includes(e.kind));
  if (mains.length) facts.push({ category: 'architecture', text: `Entry points: ${mains.slice(0, 8).map((e) => `\`${e.path}\``).join(', ')}.` });
  if (index.versionCatalog) {
    const keyLibs = Object.entries(index.versionCatalog).filter(([k]) => !k.startsWith('plugins.')).slice(0, 12);
    if (keyLibs.length) facts.push({ category: 'dependency', text: `Version catalog libraries include: ${keyLibs.map(([k, v]) => `${k} = ${v}`).join('; ')}.` });
  }
  for (const m of realModules.filter((x) => x.kind === 'npm' || x.kind === 'cargo').slice(0, 5)) {
    if (m.externalDeps.length) facts.push({ category: 'dependency', text: `${m.id} dependencies: ${m.externalDeps.slice(0, 15).join(', ')}${m.externalDeps.length > 15 ? ', …' : ''}.` });
  }
  for (const lim of index.limitations.slice(0, 6)) facts.push({ category: 'limitation', text: `Index: ${lim}` });
  return facts;
}

export function refreshVerifiedFacts(mem: ProjectMemory, index: RepoIndex, identity: RepoIdentity): ProjectMemory {
  const facts = deriveVerifiedFacts(index, identity);
  const now = new Date().toISOString();
  const keep = mem.entries.filter((e) => !(e.provenance === 'verified' && e.source === 'index'));
  const old = mem.entries.filter((e) => e.provenance === 'verified' && e.source === 'index');
  const fresh: MemoryEntry[] = facts.map((f) => {
    const existing = old.find((o) => o.category === f.category && o.text === f.text);
    return (
      existing ?? {
        id: newId(),
        category: f.category,
        text: f.text,
        provenance: 'verified',
        source: 'index',
        createdAt: now,
        updatedAt: now,
        version: 1,
        history: [{ version: 1, text: f.text, provenance: 'verified', at: now, by: 'index' }],
        archived: false
      }
    );
  });
  return bump(mem, [...keep, ...fresh]);
}

/** Pulls suggested memory items out of a DeepSeek response (Decisions / Assumptions / Risks sections). */
export function extractSuggestions(response: string): { category: MemoryCategory; text: string }[] {
  const out: { category: MemoryCategory; text: string }[] = [];
  const map: [RegExp, MemoryCategory][] = [
    [/^#{1,4}\s*(architecture )?decisions?\b/i, 'decision'],
    [/^#{1,4}\s*(assumptions|constraints)\b/i, 'constraint'],
    [/^#{1,4}\s*(known (issues|bugs)|outstanding issues)\b/i, 'known-bug'],
    [/^#{1,4}\s*(risks?|potential risks)\b/i, 'known-bug'],
    [/^#{1,4}\s*(conventions|coding conventions)\b/i, 'convention'],
    [/^#{1,4}\s*(remaining work|follow[- ]?ups?|todo|next steps|incomplete)\b/i, 'outstanding-task']
  ];
  let current: MemoryCategory | null = null;
  for (const raw of response.split('\n')) {
    const line = raw.trim();
    const bold = /^\*\*(.+?)\*\*:?$/.exec(line)?.[1];
    const heading = line.startsWith('#') ? line : bold ? `## ${bold}` : null;
    if (heading) {
      current = map.find(([re]) => re.test(heading))?.[1] ?? null;
      continue;
    }
    if (!current) continue;
    const item = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line)?.[1];
    if (item && item.length > 8 && item.length < 400) out.push({ category: current, text: item.replace(/\*\*/g, '') });
  }
  return out;
}

const TAG: Record<Provenance, string> = { verified: 'verified', approved: 'approved', suggested: 'suggested — not approved' };

export function exportMemoryMarkdown(mem: ProjectMemory, identity: RepoIdentity): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [file, cats] of Object.entries(MEMORY_FILES)) {
    const out: string[] = [`# ${file.replace('.md', '').replace(/_/g, ' ')}`, '', `Project: **${identity.name}**  `, `Exported by RepoMind on ${new Date().toISOString()} (memory revision ${mem.revision}).`, '', 'Tags: `[verified]` = derived from the repository index, `[approved]` = approved by the user, `[suggested — not approved]` = AI/heuristic suggestion.', ''];
    for (const c of cats) {
      out.push(`## ${CATEGORY_LABELS[c]}`, '');
      const entries = mem.entries.filter((e) => e.category === c && !e.archived);
      if (entries.length === 0) out.push('_None recorded._');
      for (const e of entries) out.push(`- [${TAG[e.provenance]}] ${e.text.replace(/\n/g, ' ')} <!-- id:${e.id} v${e.version} -->`);
      out.push('');
    }
    files[file] = out.join('\n');
  }
  return files;
}

/** Imports edited markdown back. Unknown/edited lines become approved user entries; nothing approved is removed. */
export function importMemoryMarkdown(mem: ProjectMemory, files: Record<string, string>): { memory: ProjectMemory; added: number; updated: number } {
  let next = mem;
  let added = 0;
  let updated = 0;
  for (const [file, content] of Object.entries(files)) {
    const cats = MEMORY_FILES[file.split('/').pop()!];
    if (!cats) continue;
    let current: MemoryCategory | null = null;
    for (const raw of content.split('\n')) {
      const h = /^##\s+(.+)$/.exec(raw.trim());
      if (h) {
        current = (Object.entries(CATEGORY_LABELS).find(([, label]) => label.toLowerCase() === h[1]!.trim().toLowerCase())?.[0] as MemoryCategory | undefined) ?? null;
        continue;
      }
      const m = /^-\s+\[(verified|approved|suggested[^\]]*)\]\s+(.+?)(?:\s*<!--\s*id:(\S+)\s+v\d+\s*-->)?\s*$/.exec(raw.trim()) ?? /^-\s+(.+)$/.exec(raw.trim());
      if (!m || !current || !cats.includes(current)) continue;
      const tagged = m.length === 4;
      const text = (tagged ? m[2] : m[1])!.trim();
      const id = tagged ? m[3] : undefined;
      if (!text || text === '_None recorded._') continue;
      const existing = id ? next.entries.find((e) => e.id === id) : undefined;
      if (existing) {
        if (existing.text !== text) {
          next = updateEntry(next, existing.id, text, 'user');
          updated++;
        }
      } else {
        const tag = tagged ? m[1]! : 'approved';
        const provenance: Provenance = tag.startsWith('suggested') ? 'suggested' : 'approved';
        const before = next.entries.length;
        next = addEntry(next, { category: current, text, provenance, source: 'import' });
        if (next.entries.length > before) added++;
      }
    }
  }
  return { memory: next, added, updated };
}

/** Memory section for prompts. Suggestions are excluded unless explicitly requested, and then labeled. */
export function renderMemoryForPrompt(mem: ProjectMemory, opts: { includeSuggested?: boolean; categories?: MemoryCategory[]; maxEntries?: number } = {}): string {
  const cats = opts.categories ?? (Object.keys(CATEGORY_LABELS) as MemoryCategory[]);
  const out: string[] = [];
  let count = 0;
  for (const c of cats) {
    const entries = mem.entries.filter((e) => e.category === c && !e.archived && (e.provenance !== 'suggested' || opts.includeSuggested));
    if (!entries.length) continue;
    out.push(`**${CATEGORY_LABELS[c]}**`);
    for (const e of entries) {
      if (opts.maxEntries && count >= opts.maxEntries) break;
      out.push(`- ${e.text}${e.provenance === 'suggested' ? ' _(unverified suggestion)_' : e.provenance === 'verified' ? ' _(verified from repository)_' : ''}`);
      count++;
    }
  }
  return out.join('\n');
}
