import { GitHubClient, fetchSnapshot, publishFiles, type FetchLike, type IngestOptions, type PublishOptions, type PublishResult } from '@repomind/core';

const browserFetch: FetchLike = (url, init) => fetch(url, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body, signal: init?.signal, credentials: 'omit', redirect: 'follow', cache: 'no-store' });

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

/** Imports a GitHub repository directly from the browser (public repos, or with a session token). Empty repos give zero files. */
export async function importViaBrowser(owner: string, repo: string, ref: string | undefined, opts: IngestOptions & { subPath?: string; useSessionToken?: boolean }, progress: (m: string) => void) {
  const token = opts.useSessionToken ? await getSessionToken() : undefined;
  return fetchSnapshot(browserGitHub(token), owner, repo, ref, opts, progress);
}

/** Publishes from the browser with the session token (used when the engine/keyring is not available). */
export async function publishViaBrowser(o: PublishOptions, progress: (m: string) => void): Promise<PublishResult> {
  const token = await getSessionToken();
  if (!token) throw new Error('Publishing needs a GitHub token with “Contents: Read and write”. Add one in Settings → GitHub access.');
  return publishFiles(browserGitHub(token), o, progress);
}
