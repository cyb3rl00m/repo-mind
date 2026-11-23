import { GitHubClient, filesFromZip, type FetchLike, type IngestOptions } from '@repomind/core';

const browserFetch: FetchLike = (url, init) => fetch(url, { headers: init?.headers, signal: init?.signal, credentials: 'omit', redirect: 'follow' });

/** Session-only token (chrome.storage.session lives in memory and is cleared when the browser quits). */
export async function getSessionToken(): Promise<string | undefined> {
  if (!chrome.storage?.session) return undefined;
  const r = await chrome.storage.session.get('githubToken');
  return typeof r['githubToken'] === 'string' ? (r['githubToken'] as string) : undefined;
}
export async function setSessionToken(token: string | null): Promise<void> {
  if (!chrome.storage?.session) return;
  if (token) await chrome.storage.session.set({ githubToken: token });
  else await chrome.storage.session.remove('githubToken');
}

export function browserGitHub(token?: string): GitHubClient {
  return new GitHubClient(browserFetch, token);
}

/** Imports a GitHub repository directly from the browser (public repos, or with a session token). */
export async function importViaBrowser(owner: string, repo: string, ref: string | undefined, opts: IngestOptions & { subPath?: string; useSessionToken?: boolean }, progress: (m: string) => void) {
  const token = opts.useSessionToken ? await getSessionToken() : undefined;
  const gh = browserGitHub(token);
  progress('Fetching repository metadata');
  const meta = await gh.repo(owner, repo);
  const branches = await gh.branches(owner, repo).catch(() => []);
  const useRef = ref || meta.defaultBranch;
  const commit = await gh.commitSha(owner, repo, useRef);
  progress(`Downloading snapshot ${commit.sha.slice(0, 10)}`);
  const zip = await gh.zipball(owner, repo, commit.sha);
  progress(`Extracting ${(zip.byteLength / 1e6).toFixed(1)} MB`);
  const r = filesFromZip(zip, opts);
  return { meta, branches, ref: useRef, commit, files: r.files, skipped: r.skipped };
}
