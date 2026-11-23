import { useRef, useState } from 'react';
import {
  CATEGORY_LABELS,
  MEMORY_FILES,
  addEntry,
  approveEntry,
  archiveEntry,
  exportMemoryMarkdown,
  importMemoryMarkdown,
  revertEntry,
  updateEntry,
  type MemoryCategory,
  type MemoryEntry,
  type ProjectMemory,
  type Provenance
} from '@repomind/core';
import { useActive, useStore } from '../lib/store';
import { Badge, Button, Card, Field, TextArea } from '../components/ui';
import { identityOf } from '../lib/types';
import { downloadText, timeAgo } from '../lib/util';

const CATS = Object.keys(CATEGORY_LABELS) as MemoryCategory[];
const PROV_TONE: Record<Provenance, 'ok' | 'accent' | 'warn'> = { verified: 'ok', approved: 'accent', suggested: 'warn' };

export function MemoryCenter() {
  const s = useStore();
  const a = useActive();
  const mem = a.memory;
  const [cat, setCat] = useState<MemoryCategory | 'all'>('all');
  const [prov, setProv] = useState<Provenance | 'all'>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [newCat, setNewCat] = useState<MemoryCategory>('decision');
  const [newText, setNewText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const save = async (m: ProjectMemory, msg?: string) => {
    await s.saveMemory(m);
    if (msg) {
      s.toast(msg, 'success');
      s.log('memory', msg);
    }
  };
  const entries = mem.entries.filter((e) => (cat === 'all' || e.category === cat) && (prov === 'all' || e.provenance === prov) && (showArchived || !e.archived));
  const suggested = mem.entries.filter((e) => e.provenance === 'suggested' && !e.archived).length;

  const exportAll = () => {
    const files = exportMemoryMarkdown(mem, identityOf(a.project));
    for (const [name, text] of Object.entries(files)) downloadText(name, text);
  };

  const importFiles = async (list: FileList) => {
    const md: Record<string, string> = {};
    let next = mem;
    let added = 0;
    let updated = 0;
    for (const f of Array.from(list)) {
      const text = await f.text();
      if (f.name.endsWith('.json')) {
        const data = JSON.parse(text) as ProjectMemory;
        if (!Array.isArray(data.entries)) throw new Error(`${f.name} is not a RepoMind memory export`);
        for (const e of data.entries) {
          if (next.entries.some((x) => x.id === e.id)) continue;
          next = { ...next, entries: [...next.entries, { ...e, provenance: e.provenance === 'verified' ? 'suggested' : e.provenance, source: `import:${f.name}` }] };
          added++;
        }
        next = { ...next, revision: next.revision + 1, updatedAt: new Date().toISOString() };
      } else if (Object.keys(MEMORY_FILES).includes(f.name)) md[f.name] = text;
    }
    if (Object.keys(md).length) {
      const r = importMemoryMarkdown(next, md);
      next = r.memory;
      added += r.added;
      updated += r.updated;
    }
    await save(next, `Memory import: ${added} added, ${updated} updated`);
  };

  return (
    <div className="stack">
      <Card
        title={`Project memory · revision ${mem.revision}`}
        subtitle="Verified = derived from the repository index. Approved = written or approved by you. Suggested = from DeepSeek/heuristics; excluded from prompts until approved."
        actions={
          <>
            <Button small icon="download" onClick={exportAll}>Export .md</Button>
            <Button small variant="ghost" onClick={() => downloadText(`repomind-memory-${a.project.name.replace(/\W+/g, '-')}.json`, JSON.stringify(mem, null, 2), 'application/json')}>JSON</Button>
            <Button small variant="ghost" onClick={() => fileRef.current?.click()}>Import</Button>
          </>
        }
      >
        <input ref={fileRef} type="file" accept=".md,.json" multiple hidden onChange={(e) => e.target.files && void importFiles(e.target.files).catch((err: Error) => s.toast(err.message, 'error')).finally(() => (e.target.value = ''))} />
        {suggested > 0 && <div className="callout warn">{suggested} suggestion(s) await your review.</div>}
        <div className="row nowrap">
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value as MemoryCategory | 'all')} aria-label="Category">
            <option value="all">All categories</option>
            {CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
          <select className="input" value={prov} onChange={(e) => setProv(e.target.value as Provenance | 'all')} aria-label="Provenance">
            <option value="all">All sources</option>
            <option value="verified">Verified</option>
            <option value="approved">Approved</option>
            <option value="suggested">Suggested</option>
          </select>
          <label className="check" style={{ whiteSpace: 'nowrap' }}><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />archived</label>
        </div>
      </Card>

      <Card title="Add an entry">
        <div className="row nowrap">
          <select className="input" style={{ width: 170 }} value={newCat} onChange={(e) => setNewCat(e.target.value as MemoryCategory)}>
            {CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
          <input className="input grow" value={newText} onChange={(e) => setNewText(e.target.value)} placeholder="e.g. All persistence goes through NoteRepository; never call DAOs from UI." onKeyDown={(e) => e.key === 'Enter' && newText.trim() && (void save(addEntry(mem, { category: newCat, text: newText, provenance: 'approved', source: 'user' }), 'Memory entry added'), setNewText(''))} />
          <Button variant="primary" icon="plus" disabled={!newText.trim()} onClick={() => { void save(addEntry(mem, { category: newCat, text: newText, provenance: 'approved', source: 'user' }), 'Memory entry added'); setNewText(''); }} />
        </div>
      </Card>

      {CATS.filter((c) => cat === 'all' || c === cat).map((c) => {
        const list = entries.filter((e) => e.category === c);
        if (!list.length) return null;
        return (
          <Card key={c} title={`${CATEGORY_LABELS[c]} (${list.length})`}>
            <div className="stack-sm">
              {list.map((e) => <EntryRow key={e.id} e={e} mem={mem} save={save} />)}
            </div>
          </Card>
        );
      })}
      {entries.length === 0 && <p className="muted small">No entries match the filters.</p>}
    </div>
  );
}

function EntryRow({ e, mem, save }: { e: MemoryEntry; mem: ProjectMemory; save: (m: ProjectMemory, msg?: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(e.text);
  return (
    <div className="card subtle" style={{ opacity: e.archived ? 0.55 : 1 }}>
      {editing ? (
        <Field label="Edit (saved as a new version; becomes approved)">
          <TextArea rows={3} value={text} onChange={(x) => setText(x.target.value)} />
        </Field>
      ) : (
        <p className="break">{e.text}</p>
      )}
      <div className="row gap-xs">
        <Badge tone={PROV_TONE[e.provenance]}>{e.provenance}</Badge>
        <span className="muted small grow truncate">v{e.version} · {e.source} · {timeAgo(e.updatedAt)}</span>
        {editing ? (
          <>
            <Button small variant="primary" onClick={() => { void save(updateEntry(mem, e.id, text), 'Memory entry updated'); setEditing(false); }}>Save</Button>
            <Button small variant="ghost" onClick={() => { setText(e.text); setEditing(false); }}>Cancel</Button>
          </>
        ) : (
          <>
            {e.provenance === 'suggested' && <Button small variant="primary" icon="check" onClick={() => void save(approveEntry(mem, e.id), 'Suggestion approved')}>Approve</Button>}
            {e.provenance !== 'verified' && <Button small variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}
            <Button small variant="ghost" onClick={() => void save(archiveEntry(mem, e.id, !e.archived), e.archived ? 'Entry restored' : 'Entry archived')}>{e.archived ? 'Restore' : 'Archive'}</Button>
          </>
        )}
      </div>
      {e.history.length > 1 && (
        <details>
          <summary className="small muted">History ({e.history.length} versions)</summary>
          <ul className="plain small" style={{ marginTop: 4 }}>
            {[...e.history].reverse().map((h) => (
              <li key={h.version} className="row nowrap">
                <Badge>v{h.version}</Badge>
                <Badge tone={PROV_TONE[h.provenance]}>{h.provenance}</Badge>
                <span className="grow truncate" title={h.text}>{h.text}</span>
                {h.version !== e.version && <Button small variant="ghost" onClick={() => void save(revertEntry(mem, e.id, h.version), `Reverted to v${h.version}`)}>Restore</Button>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
