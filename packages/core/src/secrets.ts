import { basename } from './lang.js';
import type { SecretFinding } from './types.js';

/**
 * Secret detection. Two layers:
 *  1. Secret *files* (by name) are excluded from indexing and from patches by default.
 *  2. Secret *values* inside ordinary files are detected and redacted before any context leaves RepoMind.
 */

const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)\.envrc$/,
  /\.(pem|key|p12|pfx|jks|keystore|der|crt|cer|asc|gpg|ppk|ovpn)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|properties|xml)$/i,
  /(^|\/)service[-_]?account.*\.json$/i,
  /(^|\/)keystore\.properties$/i,
  /(^|\/)signing\.properties$/i,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.docker\/config\.json$/
];

/** `.env.example` and similar templates are intentionally allowed. */
const SECRET_FILE_ALLOW: RegExp[] = [/\.env\.(example|sample|template|dist)$/i, /\.(example|sample)\.(json|ya?ml)$/i];

export function isSecretFile(path: string): boolean {
  if (SECRET_FILE_ALLOW.some((re) => re.test(path))) return false;
  // local.properties is machine-specific (sdk.dir) and frequently holds signing passwords.
  return SECRET_FILE_PATTERNS.some((re) => re.test(path)) || basename(path) === 'local.properties';
}

interface SecretRule {
  type: string;
  re: RegExp;
  /** Index of the capture group holding the secret (0 = whole match). */
  group?: number;
}

const RULES: SecretRule[] = [
  { type: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----/g },
  { type: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  { type: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g },
  { type: 'github-fine-grained-token', re: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g },
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { type: 'slack-token', re: /\bxox[abposr]-[0-9A-Za-z-]{10,}\b/g },
  { type: 'stripe-secret-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}\b/g },
  { type: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { type: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:([^\s@/'"]{4,})@[^\s'"]+/gi, group: 1 },
  {
    type: 'assigned-secret',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|storePassword|keyPassword)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
    group: 1
  }
];

/** Values that look like placeholders rather than real secrets. */
function isPlaceholder(value: string): boolean {
  return /^(\$\{.*\}|<.*>|\{\{.*\}\}|x+|\*+|changeme|change_me|password|example|your[-_].*|test|dummy|null|none|todo|redacted.*)$/i.test(value) ||
    /^(process\.env|System\.getenv|os\.environ|BuildConfig\.)/.test(value);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function preview(secret: string): string {
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}…${'*'.repeat(4)}`;
}

export function detectSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const secret = m[rule.group ?? 0] ?? m[0];
      if (rule.type === 'assigned-secret' && isPlaceholder(secret)) continue;
      findings.push({ type: rule.type, line: lineOf(text, m.index), preview: preview(secret) });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  return findings;
}

/** Replaces detected secret values with `[REDACTED:<type>]`. Returns the redacted text and the count. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const groupIdx = rule.group ?? 0;
      const secret = groupIdx === 0 ? match : (args[groupIdx] as string | undefined);
      if (!secret) return match;
      if (rule.type === 'assigned-secret' && isPlaceholder(secret)) return match;
      count++;
      const marker = `[REDACTED:${rule.type}]`;
      return groupIdx === 0 ? marker : match.replace(secret, marker);
    });
  }
  return { text: out, count };
}

/** Redacts tokens from arbitrary log text (engine logs, command output). */
export function redactForLog(text: string): string {
  return redactSecrets(text).text;
}
