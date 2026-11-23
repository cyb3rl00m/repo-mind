import { useMemo, useState } from 'react';
import { CATEGORY_LABELS, RepoGraph, type ModuleInfo } from '@repomind/core';
import { useActive, useStore } from '../lib/store';
import { Badge, Button, Card, Kv, Tabs } from '../components/ui';
import { PathLabel } from '../components/PathLabel';

type Tab = 'overview' | 'modules' | 'deps' | 'entry' | 'config' | 'memory';

export function Brain() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div className="stack">
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { id: 'overview', label: 'Architecture' },
          { id: 'modules', label: 'Module graph' },
          { id: 'deps', label: 'Dependencies' },
          { id: 'entry', label: 'Entry points' },
          { id: 'config', label: 'Configuration' },
          { id: 'memory', label: 'Memory' }
        ]}
      />
      {tab === 'overview' && <Overview />}
      {tab === 'modules' && <Modules />}
      {tab === 'deps' && <Dependencies />}
      {tab === 'entry' && <EntryPoints />}
      {tab === 'config' && <Config />}
      {tab === 'memory' && <MemorySummary />}
    </div>
  );
}

function Overview() {
  const a = useActive();
  const langs = Object.entries(a.index.stats.byLanguage).sort((x, y) => y[1].lines - x[1].lines);
  const max = Math.max(1, ...langs.map(([, v]) => v.lines));
  return (
    <>
      <Card title="Technical stack (detected)">
        {a.index.stack.length ? <ul className="bullets">{a.index.stack.map((f) => <li key={f}>{f}</li>)}</ul> : <p className="muted small">Nothing detected.</p>}
      </Card>
      <Card title="Languages">
        <div className="stack-sm">
          {langs.slice(0, 12).map(([l, v]) => (
            <div key={l} className="bar-row">
              <span className="mono truncate">{l}</span>
              <div className="bar" style={{ width: `${Math.max(2, (v.lines / max) * 100)}%` }} />
              <span className="muted small">{v.files} files</span>
            </div>
          ))}
        </div>
      </Card>
      <Card title="File roles">
        <div className="row gap-xs">
          {Object.entries(a.index.stats.byRole).map(([r, n]) => <Badge key={r}>{r}: {n}</Badge>)}
        </div>
      </Card>
      <Card title="Index limitations" subtitle="RepoMind states what it could not understand instead of guessing.">
        {a.index.limitations.length ? <ul className="bullets small">{a.index.limitations.map((l) => <li key={l}>{l}</li>)}</ul> : <p className="muted small">None recorded.</p>}
      </Card>
    </>
  );
}

function layers(mods: ModuleInfo[]): Map<string, number> {
  const ids = new Set(mods.map((m) => m.id));
  const depth = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const m = mods.find((x) => x.id === id);
    const d = Math.max(-1, ...(m?.dependsOn.filter((x) => ids.has(x)).map((x) => visit(x, stack)) ?? [])) + 1;
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  mods.forEach((m) => visit(m.id, new Set()));
  return depth;
}

function Modules() {
  const a = useActive();
  const mods = a.index.modules.slice(0, 40);
  const depth = layers(mods);
  const maxD = Math.max(0, ...depth.values());
  const cols: ModuleInfo[][] = Array.from({ length: maxD + 1 }, () => []);
  mods.forEach((m) => cols[maxD - (depth.get(m.id) ?? 0)]!.push(m));
  const W = 150;
  const H = 34;
  const GX = 60;
  const GY = 14;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, ci) => col.forEach((m, ri) => pos.set(m.id, { x: 10 + ci * (W + GX), y: 10 + ri * (H + GY) })));
  const width = 20 + cols.length * (W + GX) - GX;
  const height = 20 + Math.max(1, ...cols.map((c) => c.length)) * (H + GY) - GY;
  return (
    <>
      <Card title="Module graph" subtitle="Arrows point from a module to the modules it depends on.">
        <div style={{ overflow: 'auto' }}>
          <svg className="graph" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Module dependency graph">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {mods.flatMap((m) =>
              m.dependsOn
                .filter((d) => pos.has(d))
                .map((d) => {
                  const p1 = pos.get(m.id)!;
                  const p2 = pos.get(d)!;
                  const x1 = p1.x + W;
                  const y1 = p1.y + H / 2;
                  const x2 = p2.x;
                  const y2 = p2.y + H / 2;
                  const back = x2 <= x1;
                  return <path key={`${m.id}->${d}`} className="edge" markerEnd="url(#arrow)" d={back ? `M${p1.x + W / 2},${p1.y + H} C${p1.x + W / 2},${p1.y + H + 30} ${p2.x + W / 2},${p2.y + H + 30} ${p2.x + W / 2},${p2.y + H}` : `M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`} />;
                })
            )}
            {mods.map((m) => {
              const p = pos.get(m.id)!;
              return (
                <g key={m.id} className={`node ${m.android ? 'android' : ''}`} transform={`translate(${p.x},${p.y})`}>
                  <title>{`${m.id} (${m.kind}) — ${m.fileCount} files`}</title>
                  <rect width={W} height={H} rx={6} />
                  <text x={8} y={14}>{m.id.length > 20 ? `${m.id.slice(0, 19)}…` : m.id}</text>
                  <text x={8} y={27} opacity={0.6}>{m.android ? `android ${m.android.type}` : m.kind} · {m.fileCount}</text>
                </g>
              );
            })}
          </svg>
        </div>
      </Card>
      <Card title="Modules">
        <div className="stack-sm">
          {mods.map((m) => (
            <details key={m.id}>
              <summary className="row nowrap"><strong className="mono">{m.id}</strong><Badge>{m.kind}</Badge>{m.android && <Badge tone="ok">{m.android.type}</Badge>}<span className="muted small">{m.fileCount} files</span></summary>
              <Kv rows={[['Root', m.root || '.'], ['Build file', m.buildFile ?? '—'], ['Depends on', m.dependsOn.join(', ') || '—'], ['External deps', m.externalDeps.length ? <ul className="plain small mono" key="d">{m.externalDeps.slice(0, 40).map((d) => <li key={d}>{d}</li>)}</ul> : '—']]} />
            </details>
          ))}
        </div>
      </Card>
    </>
  );
}

function Dependencies() {
  const s = useStore();
  const a = useActive();
  const graph = useMemo(() => new RepoGraph(a.index), [a.index]);
  const hubs = useMemo(
    () => Object.keys(a.index.files).map((p) => ({ p, n: graph.inDegree(p) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, 20),
    [graph, a.index]
  );
  const focus = s.focusFile && a.index.files[s.focusFile] ? s.focusFile : hubs[0]?.p;
  const deps = focus ? graph.dependencies(focus) : [];
  const users = focus ? graph.dependents(focus) : [];
  const edgeKinds = a.index.edges.reduce<Record<string, number>>((acc, e) => ((acc[e.kind] = (acc[e.kind] ?? 0) + 1), acc), {});
  return (
    <>
      <Card title="Dependency graph" subtitle={Object.entries(edgeKinds).map(([k, n]) => `${n} ${k}`).join(' · ')}>
        <p className="muted small">Most depended-on files (shared components — changes here have the widest blast radius):</p>
        <div className="list">
          {hubs.map((h) => (
            <div key={h.p} className={`list-item clickable ${focus === h.p ? 'selected' : ''}`} onClick={() => s.setFocusFile(h.p)}>
              <PathLabel path={h.p} />
              <span className="grow" />
              <Badge tone={h.n >= 10 ? 'warn' : 'neutral'}>{h.n} dependents</Badge>
            </div>
          ))}
        </div>
      </Card>
      {focus && (
        <Card title={<PathLabel path={focus} />} actions={<Button small onClick={() => s.setScreen('explorer')}>Open in Explorer</Button>}>
          <div className="grid-2">
            <div className="stack-sm">
              <strong className="small">Depends on ({deps.length})</strong>
              {deps.map((d) => <div key={d} className="clickable" onClick={() => s.setFocusFile(d)}><PathLabel path={d} /></div>)}
            </div>
            <div className="stack-sm">
              <strong className="small">Used by ({users.length})</strong>
              {users.map((d) => <div key={d} className="clickable" onClick={() => s.setFocusFile(d)}><PathLabel path={d} /></div>)}
            </div>
          </div>
        </Card>
      )}
    </>
  );
}

function EntryPoints() {
  const s = useStore();
  const a = useActive();
  return (
    <Card title={`Entry points (${a.index.entryPoints.length})`}>
      {a.index.entryPoints.length === 0 && <p className="muted small">None detected.</p>}
      <div className="list">
        {a.index.entryPoints.map((e, i) => (
          <div key={i} className="list-item clickable" onClick={() => { s.setFocusFile(e.path); s.setScreen('explorer'); }}>
            <Badge tone={e.kind === 'android-launcher-activity' ? 'accent' : 'neutral'}>{e.kind}</Badge>
            <div className="grow stack-sm" style={{ gap: 0 }}>
              <PathLabel path={e.path} />
              <span className="muted small truncate">{e.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Config() {
  const s = useStore();
  const a = useActive();
  return (
    <Card title={`Configuration map (${a.index.config.length})`}>
      <div className="list">
        {a.index.config.map((c) => (
          <div key={c.path} className="list-item clickable" onClick={() => { s.setFocusFile(c.path); s.setScreen('explorer'); }}>
            <Badge>{c.kind}</Badge>
            <div className="grow stack-sm" style={{ gap: 0 }}>
              <PathLabel path={c.path} />
              <span className="muted small">{c.summary}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function MemorySummary() {
  const s = useStore();
  const a = useActive();
  const counts = a.memory.entries.filter((e) => !e.archived).reduce<Record<string, number>>((acc, e) => ((acc[e.category] = (acc[e.category] ?? 0) + 1), acc), {});
  return (
    <Card title="Project memory" actions={<Button small onClick={() => s.setScreen('memory')}>Open Memory Center</Button>}>
      <div className="row gap-xs">
        {Object.entries(counts).map(([c, n]) => <Badge key={c}>{CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS]}: {n}</Badge>)}
      </div>
      <p className="muted small">Revision {a.memory.revision} · {a.memory.entries.filter((e) => e.provenance === 'suggested' && !e.archived).length} suggestions awaiting approval.</p>
    </Card>
  );
}
