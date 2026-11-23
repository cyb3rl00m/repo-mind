import { basename } from '../lang.js';
import type { Language } from '../types.js';
import {
  parseAndroidManifest,
  parseAndroidXml,
  parseCargoToml,
  parseGoMod,
  parseGradle,
  parseMarkdown,
  parsePackageJson,
  parsePyProject,
  parseRequirements,
  parseVersionCatalog
} from './build.js';
import { parseJava, parseKotlin } from './jvm.js';
import { parseCFamily, parseGo, parsePython, parseRust } from './langs.js';
import { parseTsJs } from './tsjs.js';
import { emptyResult, type ParseResult } from './util.js';

export type { ParseResult, BuildInfo } from './util.js';
export { parseTomlSubset } from './build.js';
export { scanSource } from './scan.js';

/** Parses one file. Never throws: parser failures degrade to `fidelity: 'none'` with a note. */
export function parseFile(path: string, language: Language, content: string): ParseResult {
  try {
    const base = basename(path);
    if (base === 'package.json') return parsePackageJson(content);
    if (base === 'Cargo.toml') return parseCargoToml(content);
    if (base === 'go.mod') return parseGoMod(content);
    if (base === 'pyproject.toml') return parsePyProject(content);
    if (/^requirements.*\.txt$/.test(base)) return parseRequirements(content);
    if (base.endsWith('.versions.toml')) return parseVersionCatalog(content);
    switch (language) {
      case 'kotlin':
        if (base.endsWith('.kts')) return parseGradle(content); // non-gradle .kts scripts: best effort
        return parseKotlin(content);
      case 'gradle':
      case 'gradle-kts':
        return parseGradle(content);
      case 'java':
        return parseJava(content);
      case 'typescript':
        return parseTsJs(content, true);
      case 'javascript':
        return parseTsJs(content, false);
      case 'python':
        return parsePython(content);
      case 'rust':
        return parseRust(content);
      case 'go':
        return parseGo(content);
      case 'c':
        return parseCFamily(content, /\.(hpp|hh|hxx)$/.test(path));
      case 'cpp':
        return parseCFamily(content, true);
      case 'android-manifest':
        return parseAndroidManifest(content);
      case 'xml':
        return /(^|\/)res\//.test(path) ? parseAndroidXml(content) : emptyResult('none');
      case 'markdown':
        return parseMarkdown(content);
      default:
        return emptyResult('none');
    }
  } catch (err) {
    const r = emptyResult('none');
    r.notes.push(`Parser error: ${(err as Error).message}`);
    return r;
  }
}
