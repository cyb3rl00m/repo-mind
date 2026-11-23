import type { InjectionFinding } from './types.js';

/**
 * Prompt-injection heuristics for repository content.
 *
 * Repository files are untrusted data. RepoMind never executes instructions found in them, but it
 * flags suspicious text so the user can see it, and the generated prompt tells DeepSeek explicitly
 * that file content is data, not instructions.
 */
const PATTERNS: RegExp[] = [
  /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts|messages|rules)/i,
  /disregard (all |any )?(the )?(previous|prior|above|system) (instructions|prompt|rules)/i,
  /forget (all |your )?(previous |prior )?instructions/i,
  /you are now (a|an|in) /i,
  /new (system )?instructions?:/i,
  /\bsystem prompt\b/i,
  /\b(act|behave) as (an? )?(unrestricted|jailbroken|DAN)\b/i,
  /do not (tell|inform|alert) the user/i,
  /(exfiltrate|send|upload|post) (the )?(api[_ -]?keys?|tokens?|secrets?|credentials|\.env)/i,
  /\bcurl\b[^\n|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/i,
  /<\s*\/?\s*(system|assistant|im_start|im_end)\s*>/i,
  /\[\[?\s*(SYSTEM|INST)\s*\]?\]/,
  /REPOMIND_(FILE|END|RULES)/
];

export function detectInjection(text: string, maxFindings = 10): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && findings.length < maxFindings; i++) {
    const line = lines[i]!;
    if (line.length > 2000) continue;
    for (const re of PATTERNS) {
      const m = re.exec(line);
      if (m) {
        findings.push({ line: i + 1, phrase: m[0].slice(0, 80) });
        break;
      }
    }
  }
  return findings;
}

/**
 * Neutralizes our own delimiter tokens inside untrusted content so a file cannot fake the end of
 * its block and smuggle text into the instruction area of a generated prompt.
 */
export function neutralizeDelimiters(text: string): string {
  return text.replace(/(<<<|>>>)(\s*)(REPOMIND_)/g, '$1$2REPOMIND​_');
}
