import { useMemo, useState } from 'react';
import { RepoGraph, formatTokens } from '@repomind/core';
import { useActive, useStore } from '../lib/store';
import { Badge, Button, Card, CodeBlock, Empty, Kv } from '../components/ui';
import { PathLabel } from '../components/PathLabel';

interface Node {
  name: string;
  path: string;
  dir: boolean;
  children: Node[];
}

function buildTree(paths: string[]): Node {
  const root: Node = { name: '', path: '', dir: true, children: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let cur = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const dir = i < parts.length - 1;
      let next = cur.children.find((c) => c.name === part && c.dir === dir);
      if (!next) {
        next = { name: part, path, dir, children: [] };
        cur.children.push(next);
      }
      cur = next;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

export function Explorer() {
  const s = useStore();
  const a = useActive();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const selected = s.focusFile && a.index.files[s.focusFile] ? s.focusFile : null;
  const graph = useMemo(() => new RepoGraph(a.index), [a.index]);
  const paths = useMemo(() => Object.keys(a.index.files).sort(), [a.index]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const bySymbol = Object.entries(a.index.symbolIndex)
      .filter(([name]) => name.toLowerCase().includes(q))
      .slice(0, 60)
      .flatMap(([name, locs]) => locs.map((l) => ({ path: l.path, label: `${name} · ${l.kind} · L${l.line}`, line: l.line })));
    const byPath = paths.filter((p) => p.toLowerCase().includes(q)).slice(0, 80).map((p) => ({ path: p, label: '', line: 0 }));
    return { byPath, bySymbol };
  }, [query, a.index, paths]);

  const tree = useMemo(() => buildTree(paths), [paths]);
  const rows: { node: Node; depth: number }[] = [];
  const walk = (n: Node, depth: number) => {
    for (const c of n.children) {
      rows.push({ node: c, depth });
      if (c.dir && (open.has(c.path) || depth === 0 && n.children.length === 1)) walk(c, depth + 1);
    }
  };
  walk(tree, 0);

  const toggle = (p: string) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });

  const pin = (kind: 'pinnedInclude' | 'pinnedExclude', path: string) => {
    const other = kind === 'pinnedInclude' ? 'pinnedExclude' : 'pinnedInclude';
    const cur = new Set(a.project[kind]);
    if (cur.has(path)) cur.delete(path);
    else cur.add(path);
    void s.updateProject(a.project.id, { [kind]: [...cur], [other]: a.project[other].filter((x) => x !== path) });
  };

  const rec = selected ? a.index.files[selected] : null;
  const [line, setLine] = useState<number | undefined>(undefined);

  return (
    <div className="stack">
      <input className="input" placeholder="Search files and symbols…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
      {matches ? (
        <Card title={`Results: ${matches.byPath.length} files, ${matches.bySymbol.length} symbols`}>
          <div className="list" style={{ maxHeight: 320, overflow: 'auto' }}>
            {[...matches.bySymbol, ...matches.byPath].map((m, i) => (
              <div key={i} className={`list-item clickable ${selected === m.path ? 'selected' : ''}`} onClick={() => { s.setFocusFile(m.path); setLine(m.line || undefined); }}>
                <PathLabel path={m.path} />
                {m.label && <span className="muted small truncate">{m.label}</span>}
              </div>
            ))}
            {matches.byPath.length + matches.bySymbol.length === 0 && <div className="pad muted small">No matches.</div>}
          </div>
        </Card>
      ) : (
        <div className="tree" role="tree">
          {rows.map(({ node, depth }) => {
            const excluded = a.project.pinnedExclude.includes(node.path);
            const included = a.project.pinnedInclude.includes(node.path);
            return (
              <div
                key={node.path}
                role="treeitem"
                aria-expanded={node.dir ? open.has(node.path) : undefined}
                className={`tree-row ${selected === node.path ? 'selected' : ''}`}
                style={{ paddingLeft: 8 + depth * 12, opacity: excluded ? 0.45 : 1 }}
                onClick={() => (node.dir ? toggle(node.path) : (s.setFocusFile(node.path), setLine(undefined)))}
              >
                <span className="twisty">{node.dir ? (open.has(node.path) ? '▾' : '▸') : ''}</span>
                <span className={node.dir ? 'muted' : ''}>{node.name}</span>
                {included && <Badge tone="accent">pinned</Badge>}
                {!node.dir && a.index.files[node.path]!.secretFindings.length > 0 && <Badge tone="bad">secret</Badge>}
              </div>
            );
          })}
        </div>
      )}

      {rec ? (
        <Card
          title={<PathLabel path={rec.path} />}
          actions={
            <>
              <Button small variant={a.project.pinnedInclude.includes(rec.path) ? 'primary' : 'secondary'} onClick={() => pin('pinnedInclude', rec.path)} title="Always include in context packages">
                {a.project.pinnedInclude.includes(rec.path) ? 'Included' : 'Include'}
              </Button>
              <Button small variant={a.project.pinnedExclude.includes(rec.path) ? 'danger' : 'ghost'} onClick={() => pin('pinnedExclude', rec.path)} title="Never include in context packages">
                {a.project.pinnedExclude.includes(rec.path) ? 'Excluded' : 'Exclude'}
              </Button>
            </>
          }
        >
          <Kv
            rows={[
              ['Language', `${rec.language} · ${rec.role}${rec.module ? ` · module ${rec.module}` : ''}`],
              ['Size', `${rec.lines} lines · ≈${formatTokens(rec.tokensEstimate)} tokens (estimate)`],
              ['Parser', rec.fidelity === 'lexical' ? 'lexical (regex + structure tracking, not a full AST)' : rec.fidelity === 'structural' ? 'structural' : 'none — content only'],
              ...(rec.pkg ? ([['Package', rec.pkg]] as [string, string][]) : [])
            ]}
          />
          {rec.secretFindings.length > 0 && <div className="callout bad">Possible secrets: {rec.secretFindings.map((f) => `${f.type} (line ${f.line})`).join(', ')}. They are redacted from every context package.</div>}
          {rec.injectionFindings.length > 0 && <div className="callout warn">Instruction-like text: {rec.injectionFindings.map((f) => `L${f.line} “${f.phrase}”`).join('; ')}. Treated as untrusted data.</div>}
          {rec.notes.map((n) => <div key={n} className="callout">{n}</div>)}
          {rec.symbols.length > 0 && (
            <details open={rec.symbols.length < 30}>
              <summary className="small"><strong>Symbols ({rec.symbols.length})</strong></summary>
              <ul className="plain small" style={{ marginTop: 6 }}>
                {rec.symbols.map((sym, i) => (
                  <li key={i} className="row nowrap" style={{ cursor: 'pointer' }} onClick={() => setLine(sym.line)}>
                    <Badge tone={sym.exported ? 'accent' : 'neutral'}>{sym.kind}</Badge>
                    <span className="mono truncate grow">{sym.container ? `${sym.container}.` : ''}{sym.name}{sym.returnType ? `: ${sym.returnType}` : ''}</span>
                    <span className="muted">L{sym.line}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <Relations title="Depends on" items={graph.out.get(rec.path)?.map((e) => ({ path: e.to, kind: e.kind })) ?? []} />
          <Relations title="Used by" items={graph.in.get(rec.path)?.map((e) => ({ path: e.from, kind: e.kind })) ?? []} />
          {rec.imports.some((i) => i.external || i.unresolved) && (
            <details>
              <summary className="small"><strong>External / unresolved imports</strong></summary>
              <ul className="plain small mono" style={{ marginTop: 6 }}>
                {rec.imports.filter((i) => i.external || i.unresolved).map((i, k) => (
                  <li key={k}>{i.unresolved ? <Badge tone="warn">unresolved</Badge> : <Badge>external</Badge>} {i.spec}</li>
                ))}
              </ul>
            </details>
          )}
          <CodeBlock code={a.contents.get(rec.path) ?? ''} maxHeight={460} highlightLine={line} />
        </Card>
      ) : (
        <Card>
          <Empty title="Select a file">Browse the tree or search for a file or symbol to see its structure, dependencies and content.</Empty>
        </Card>
      )}
    </div>
  );
}

function Relations({ title, items }: { title: string; items: { path: string; kind: string }[] }) {
  const s = useStore();
  if (!items.length) return null;
  return (
    <details open={items.length <= 8}>
      <summary className="small"><strong>{title} ({items.length})</strong></summary>
      <div className="list" style={{ marginTop: 6 }}>
        {items.map((it, i) => (
          <div key={i} className="list-item clickable" onClick={() => s.setFocusFile(it.path)}>
            <Badge>{it.kind}</Badge>
            <PathLabel path={it.path} />
          </div>
        ))}
      </div>
    </details>
  );
}
