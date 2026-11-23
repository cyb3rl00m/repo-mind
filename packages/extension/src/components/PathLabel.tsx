/** File name first (never truncated), directory after it (truncated) — readable in a narrow side panel. */
export function PathLabel({ path }: { path: string }) {
  const i = path.lastIndexOf('/');
  return (
    <span className="path-label" title={path}>
      <span className="path-file">{path.slice(i + 1)}</span>
      {i >= 0 && <span className="path-dir">{path.slice(0, i)}</span>}
    </span>
  );
}
