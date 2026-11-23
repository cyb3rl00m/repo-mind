import { PathFilter, decodeText, looksBinary, type IngestOptions, type SkippedFile, type SourceFile } from '@repomind/core';
import { db } from './db';

/** Browser-only folder import (File System Access API). Read-only: no git, no builds. */
type DirHandle = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

export function browserFolderSupported(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function pickBrowserFolder(): Promise<DirHandle> {
  const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
  return picker({ mode: 'read' });
}

export async function storeHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await db.put('kv', `handle:${key}`, handle);
}

export async function loadHandle(key: string): Promise<DirHandle | undefined> {
  const h = await db.get<DirHandle>('kv', `handle:${key}`);
  if (!h) return undefined;
  const perm = h as unknown as { queryPermission(o: object): Promise<string>; requestPermission(o: object): Promise<string> };
  if ((await perm.queryPermission({ mode: 'read' })) !== 'granted' && (await perm.requestPermission({ mode: 'read' })) !== 'granted') return undefined;
  return h;
}

export async function scanBrowserFolder(root: DirHandle, opts: IngestOptions, progress: (n: number) => void): Promise<{ files: SourceFile[]; skipped: SkippedFile[] }> {
  const filter = new PathFilter(opts);
  const files: SourceFile[] = [];
  const skipped: SkippedFile[] = [];
  let seen = 0;
  const walk = async (dir: DirHandle, rel: string) => {
    const entries: FileSystemHandle[] = [];
    for await (const e of dir.values()) entries.push(e);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const gi = entries.find((e) => e.name === '.gitignore' && e.kind === 'file') as FileSystemFileHandle | undefined;
    if (gi) filter.addGitignore(rel, await (await gi.getFile()).text());
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.kind === 'directory') {
        if (!filter.isIgnored(p, true)) await walk(e as DirHandle, p);
        continue;
      }
      seen++;
      if (seen % 200 === 0) progress(seen);
      const f = await (e as FileSystemFileHandle).getFile();
      const reason = filter.check(p, f.size);
      if (reason) {
        skipped.push({ path: p, reason });
        continue;
      }
      if (files.length >= filter.options.maxFiles) {
        skipped.push({ path: p, reason: 'limit' });
        continue;
      }
      const buf = new Uint8Array(await f.arrayBuffer());
      if (looksBinary(buf)) skipped.push({ path: p, reason: 'binary' });
      else files.push({ path: p, content: decodeText(buf), size: f.size });
    }
  };
  await walk(root, '');
  return { files, skipped };
}
