import { findExecutable, run } from './proc.js';

/**
 * Native folder picker. KDE (CachyOS default) -> kdialog, GNOME/others -> zenity,
 * then xdg-desktop-portal is not used (it needs a D-Bus client). Returns null if cancelled.
 */
export async function pickFolder(title = 'Open project folder in RepoMind'): Promise<{ path: string | null; picker: string | null }> {
  const home = process.env['HOME'] ?? '/';
  const kdialog = findExecutable('kdialog');
  if (kdialog) {
    const r = await run(kdialog, ['--title', title, '--getexistingdirectory', home], { timeoutMs: 10 * 60_000 });
    return { path: r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null, picker: 'kdialog' };
  }
  const zenity = findExecutable('zenity');
  if (zenity) {
    const r = await run(zenity, ['--file-selection', '--directory', `--title=${title}`, `--filename=${home}/`], { timeoutMs: 10 * 60_000 });
    return { path: r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null, picker: 'zenity' };
  }
  return { path: null, picker: null };
}
