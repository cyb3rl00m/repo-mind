/**
 * Token estimation.
 *
 * DeepSeek's tokenizer is not shipped with RepoMind, so every number produced here is an
 * ESTIMATE. The heuristic is calibrated for BPE tokenizers on source code: roughly 3.4 characters
 * per token for ASCII code, with whitespace runs compressed and non-ASCII characters (CJK, emoji,
 * Cyrillic) counted closer to one token per character.
 */
export const TOKEN_ESTIMATE_LABEL = 'estimated (heuristic, not DeepSeek’s tokenizer)';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  let wsRun = 0;
  let compressedWs = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9) {
      wsRun++;
      continue;
    }
    if (wsRun > 0) {
      // A run of indentation is usually a single token or two.
      compressedWs += Math.min(wsRun, 1 + Math.floor(wsRun / 8));
      wsRun = 0;
    }
    if (c < 128) ascii++;
    else if (c >= 0xd800 && c <= 0xdbff) {
      nonAscii++;
      i++;
    } else nonAscii++;
  }
  if (wsRun > 0) compressedWs += Math.min(wsRun, 1 + Math.floor(wsRun / 8));
  return Math.ceil((ascii + compressedWs) / 3.4 + nonAscii * 0.9);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
