import type { GraphEdge, RepoIndex } from './types.js';

/** Adjacency view over the index edges, built once per index. */
export class RepoGraph {
  readonly out = new Map<string, GraphEdge[]>();
  readonly in = new Map<string, GraphEdge[]>();

  constructor(readonly index: RepoIndex) {
    for (const e of index.edges) {
      (this.out.get(e.from) ?? this.out.set(e.from, []).get(e.from)!).push(e);
      (this.in.get(e.to) ?? this.in.set(e.to, []).get(e.to)!).push(e);
    }
  }

  dependencies(path: string, kinds?: GraphEdge['kind'][]): string[] {
    return (this.out.get(path) ?? []).filter((e) => !kinds || kinds.includes(e.kind)).map((e) => e.to);
  }

  dependents(path: string, kinds?: GraphEdge['kind'][]): string[] {
    return (this.in.get(path) ?? []).filter((e) => !kinds || kinds.includes(e.kind)).map((e) => e.from);
  }

  inDegree(path: string): number {
    return (this.in.get(path) ?? []).filter((e) => e.kind !== 'test').length;
  }

  /** Breadth-first reverse traversal: who (transitively) depends on `start`. Returns path -> depth. */
  reverseClosure(start: string[], maxDepth: number, limit = 500): Map<string, number> {
    const seen = new Map<string, number>(start.map((s) => [s, 0]));
    let frontier = [...start];
    for (let d = 1; d <= maxDepth && frontier.length && seen.size < limit; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const dep of this.dependents(f)) {
          if (!seen.has(dep)) {
            seen.set(dep, d);
            next.push(dep);
            if (seen.size >= limit) break;
          }
        }
      }
      frontier = next;
    }
    return seen;
  }

  /** Tests covering a file: test files that import it or are linked by naming convention. */
  testsFor(path: string): string[] {
    return (this.in.get(path) ?? []).filter((e) => this.index.files[e.from]?.role === 'test').map((e) => e.from);
  }
}
