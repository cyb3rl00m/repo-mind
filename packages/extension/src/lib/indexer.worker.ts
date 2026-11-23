/// <reference lib="webworker" />
import { buildIndex, type SkippedFile, type SourceFile } from '@repomind/core';

self.onmessage = (e: MessageEvent<{ files: SourceFile[]; skipped: SkippedFile[] }>) => {
  try {
    const index = buildIndex(e.data.files, e.data.skipped, (done, total) => self.postMessage({ type: 'progress', done, total }));
    self.postMessage({ type: 'done', index });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err as Error).message });
  }
};
