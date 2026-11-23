import type { RepoIndex, SkippedFile, SourceFile } from '@repomind/core';

/** Builds the index in a Web Worker so the side panel stays responsive. */
export function indexInWorker(files: SourceFile[], skipped: SkippedFile[], onProgress?: (done: number, total: number) => void): Promise<RepoIndex> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./indexer.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ type: string; index?: RepoIndex; done?: number; total?: number; message?: string }>) => {
      if (e.data.type === 'progress') onProgress?.(e.data.done!, e.data.total!);
      else if (e.data.type === 'done') {
        worker.terminate();
        resolve(e.data.index!);
      } else {
        worker.terminate();
        reject(new Error(e.data.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Indexer worker failed'));
    };
    worker.postMessage({ files, skipped });
  });
}
