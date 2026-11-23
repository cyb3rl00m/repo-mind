import type { RepoIdentity } from '@repomind/core';

export type ProjectSource = 'github' | 'local-engine' | 'local-browser';

export interface Project {
  id: string;
  name: string;
  source: ProjectSource;
  github?: { owner: string; repo: string; ref: string; sha: string; private: boolean; viaEngine: boolean; subPath?: string; branches: string[]; commitMessage?: string };
  engine?: { projectId: string; root: string; worktreeOf?: string; branch?: string | null; head?: string | null; dirty?: number };
  browser?: { handleKey: string };
  createdAt: string;
  indexedAt?: string;
  stats?: { files: number; lines: number; skipped: number; tokens: number };
  status: 'new' | 'indexing' | 'ready' | 'error';
  error?: string;
  pinnedInclude: string[];
  pinnedExclude: string[];
}

export interface Settings {
  budgetTokens: number;
  reservedTokens: number;
  extraExclusions: string[];
  maxFileKb: number;
  maxFiles: number;
  theme: 'dark' | 'light';
  notifications: boolean;
  autoConnectEngine: boolean;
  deepseekUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  budgetTokens: 48000,
  reservedTokens: 4000,
  extraExclusions: [],
  maxFileKb: 768,
  maxFiles: 25000,
  theme: 'dark',
  notifications: false,
  autoConnectEngine: true,
  deepseekUrl: 'https://chat.deepseek.com/',
};

export interface Activity {
  id: string;
  at: string;
  projectId?: string;
  kind: 'import' | 'index' | 'prompt' | 'patch' | 'run' | 'memory' | 'task' | 'error';
  text: string;
}

export function identityOf(p: Project): RepoIdentity {
  return {
    name: p.name,
    source: p.source,
    owner: p.github?.owner,
    repo: p.github?.repo,
    branch: p.github?.ref ?? p.engine?.branch ?? undefined,
    commit: p.github?.sha ?? p.engine?.head ?? undefined,
    path: p.engine?.root,
    dirty: p.engine ? (p.engine.dirty ?? 0) > 0 : undefined
  };
}
