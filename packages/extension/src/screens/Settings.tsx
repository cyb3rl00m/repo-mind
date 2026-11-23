import { useEffect, useState } from 'react';
import { DEFAULT_EXCLUSIONS, formatTokens, type EngineMethods } from '@repomind/core';
import { useStore } from '../lib/store';
import { Badge, Button, Card, Confirm, Field, Kv, TextArea } from '../components/ui';
import { engine } from '../lib/engine';
import { browserGitHub, getSessionToken, setSessionToken } from '../lib/github';
import { db } from '../lib/db';
import { bytes, downloadText, openUrl } from '../lib/util';

export function SettingsScreen() {
  const s = useStore();
  const es = s.engineState;
  const set = s.updateSettings;
  return (
    <div className="stack">
      <Card title="Local engine" actions={es.status === 'connected' ? <Button small variant="ghost" onClick={() => engine.disconnect()}>Disconnect</Button> : <Button small icon="refresh" onClick={() => void s.connectEngine()}>Connect</Button>}>
        {es.status === 'connected' ? (
          <Kv rows={[['Status', <Badge key="s" tone="ok">connected</Badge>], ['Version', `${es.info.engineVersion} · protocol v${es.info.protocol}`], ['Runtime', `Node ${es.info.node} on ${es.info.platform}/${es.info.arch}`], ['Config', <code key="c">{es.info.configPath}</code>], ['Log', <code key="l">{es.info.logPath}</code>]]} />
        ) : (
          <div className="stack-sm">
            <div className="callout warn">{es.status === 'connecting' ? 'Connecting…' : es.error ?? 'Not connected.'}</div>
            <p className="small">Install on CachyOS from the repository root:</p>
            <pre className="terminal">{`./scripts/install.sh\n~/.local/share/repomind/engine/repomind-engine --doctor`}</pre>
            <p className="muted small">This extension’s ID: <code>{chrome.runtime?.id}</code> — the installer registers the engine for exactly this ID.</p>
          </div>
        )}
        <label className="check"><input type="checkbox" checked={s.settings.autoConnectEngine} onChange={(e) => void set({ autoConnectEngine: e.target.checked })} />Connect automatically when RepoMind opens</label>
      </Card>

      <GitHubSettings />

      <Card title="Indexing">
        <Field label="Extra exclusions (gitignore syntax, one per line)" hint={`Built-in defaults also apply: ${DEFAULT_EXCLUSIONS.slice(0, 10).join(', ')} …`}>
          <TextArea rows={4} defaultValue={s.settings.extraExclusions.join('\n')} onBlur={(e) => void set({ extraExclusions: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} placeholder={'docs/generated/\n*.snap'} />
        </Field>
        <div className="grid-2">
          <Field label="Max file size (KB)"><input className="input" type="number" min={16} max={16384} value={s.settings.maxFileKb} onChange={(e) => void set({ maxFileKb: Math.max(16, Number(e.target.value)) })} /></Field>
          <Field label="Max files"><input className="input" type="number" min={100} max={200000} value={s.settings.maxFiles} onChange={(e) => void set({ maxFiles: Math.max(100, Number(e.target.value)) })} /></Field>
        </div>
        <p className="muted small">Changes apply on the next refresh. Secret files (.env, keystores, keys, local.properties) are always excluded; secret values in other files are redacted from prompts.</p>
      </Card>

      <Card title="Context budget">
        <div className="grid-2">
          <Field label="Default budget (tokens, estimated)" hint={`${formatTokens(s.settings.budgetTokens)} — keep below what your DeepSeek session accepts.`}>
            <input className="input" type="number" min={2000} max={1000000} step={1000} value={s.settings.budgetTokens} onChange={(e) => void set({ budgetTokens: Math.max(2000, Number(e.target.value)) })} />
          </Field>
          <Field label="Reserved for instructions & memory">
            <input className="input" type="number" min={0} max={50000} step={500} value={s.settings.reservedTokens} onChange={(e) => void set({ reservedTokens: Math.max(0, Number(e.target.value)) })} />
          </Field>
        </div>
        <Field label="DeepSeek URL" hint="Opened in a normal tab. RepoMind never reads or automates the page.">
          <input className="input" value={s.settings.deepseekUrl} onChange={(e) => void set({ deepseekUrl: e.target.value })} />
        </Field>
      </Card>

      <Card title="Appearance & notifications">
        <div className="row">
          <Button small variant={s.settings.theme === 'dark' ? 'primary' : 'secondary'} onClick={() => void set({ theme: 'dark' })}>Dark</Button>
          <Button small variant={s.settings.theme === 'light' ? 'primary' : 'secondary'} onClick={() => void set({ theme: 'light' })}>Light</Button>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={s.settings.notifications}
            onChange={async (e) => {
              if (e.target.checked) {
                const granted = await chrome.permissions.request({ permissions: ['notifications'] });
                await set({ notifications: granted });
              } else {
                await chrome.permissions.remove({ permissions: ['notifications'] }).catch(() => false);
                await set({ notifications: false });
              }
            }}
          />
          System notification when a build/test command finishes (asks for the optional “notifications” permission)
        </label>
      </Card>

      <DataSettings />
    </div>
  );
}

function GitHubSettings() {
  const s = useStore();
  const connected = s.engineState.status === 'connected';
  const [status, setStatus] = useState<EngineMethods['secrets.status']['result'] | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [hasSession, setHasSession] = useState(false);

  const refresh = async () => {
    setHasSession(Boolean(await getSessionToken()));
    if (connected) setStatus(await engine.call('secrets.status', {}).catch(() => null));
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const keyringOk = Boolean(status?.available);
  const store = async () => {
    setBusy(true);
    try {
      if (keyringOk) {
        const r = await engine.call('secrets.setGithubToken', { token: token.trim() });
        setWarning(r.warning);
        s.toast(`Token stored in the system keyring${r.login ? ` (GitHub user ${r.login})` : ''}.`, 'success');
      } else {
        const info = await browserGitHub(token.trim()).tokenInfo();
        await setSessionToken(token.trim());
        setWarning(info.classic ? 'Classic token detected. A fine-grained token limited to Contents: Read-only + Metadata: Read-only on selected repositories is safer.' : null);
        s.toast(`Session token saved for ${info.login}. It is kept in memory only and cleared when the browser closes.`, 'success');
      }
      setToken('');
      await refresh();
    } catch (e) {
      s.toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="GitHub access" subtitle="Only needed for private repositories. Use a fine-grained personal access token with read-only permissions.">
      <Kv
        rows={[
          ['Keyring', connected ? (status ? (status.available ? <Badge key="k" tone="ok">available</Badge> : <span key="k" className="small">{status.detail}</span>) : '…') : 'engine not connected'],
          ['Stored token', status?.hasGithubToken ? <Badge key="t" tone="accent">in keyring</Badge> : hasSession ? <Badge key="t" tone="warn">session only</Badge> : 'none']
        ]}
      />
      <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
        <li>Open <a href="#" onClick={(e) => { e.preventDefault(); openUrl('https://github.com/settings/personal-access-tokens/new'); }}>GitHub → Fine-grained tokens</a>.</li>
        <li>Repository access: <em>Only select repositories</em>.</li>
        <li>Permissions: <strong>Contents: Read-only</strong>, <strong>Metadata: Read-only</strong>. Nothing else.</li>
      </ol>
      <div className="row nowrap">
        <input className="input grow mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" aria-label="GitHub token" />
        <Button variant="primary" busy={busy} disabled={!token.trim()} onClick={() => void store()}>{keyringOk ? 'Store in keyring' : 'Use for this session'}</Button>
      </div>
      {warning && <div className="callout warn">{warning}</div>}
      <div className="row">
        {status?.hasGithubToken && <Button small variant="danger" icon="trash" onClick={async () => { await engine.call('secrets.deleteGithubToken', {}); s.toast('Token removed from keyring.'); await refresh(); }}>Remove from keyring</Button>}
        {hasSession && <Button small variant="danger" icon="trash" onClick={async () => { await setSessionToken(null); await refresh(); }}>Forget session token</Button>}
      </div>
      <p className="muted small">Removing it here does not revoke it. To revoke, delete the token at github.com/settings/personal-access-tokens. Tokens never appear in prompts, exports or logs.</p>
    </Card>
  );
}

function DataSettings() {
  const s = useStore();
  const [usage, setUsage] = useState<{ usage?: number; quota?: number } | null>(null);
  const [wipe, setWipe] = useState(false);
  useEffect(() => {
    void navigator.storage?.estimate().then(setUsage);
  }, [s.projects.length]);
  return (
    <Card title="Privacy & data">
      <ul className="bullets small">
        <li>No telemetry, analytics or crash reporting. No AI API calls.</li>
        <li>Network: GitHub (only when you import/refresh) and nothing else. DeepSeek is opened as a normal tab; RepoMind never reads it.</li>
        <li>Indexes, snapshots, memory and tasks are stored locally in this browser profile (IndexedDB).</li>
      </ul>
      <p className="small">Local storage used: {usage?.usage !== undefined ? bytes(usage.usage) : '…'}</p>
      <div className="row">
        <Button small icon="download" onClick={async () => {
          const dump: Record<string, unknown> = {};
          for (const st of ['projects', 'memory', 'tasks', 'runs', 'activity'] as const) dump[st] = await db.all(st);
          downloadText(`repomind-data-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(dump, null, 2), 'application/json');
        }}>Export data (without source snapshots)</Button>
        <Button small variant="danger" icon="trash" onClick={() => setWipe(true)}>Delete all RepoMind data</Button>
      </div>
      {wipe && (
        <Confirm title="Delete all RepoMind data?" confirmLabel="Delete everything" danger onCancel={() => setWipe(false)} onConfirm={async () => { await s.wipeAll(); setWipe(false); s.toast('All local RepoMind data deleted.'); }}>
          <p>Deletes every project index, snapshot, memory, task, run history and the session token from this browser. Your repositories and the keyring token are not touched (remove the keyring token in GitHub settings above).</p>
        </Confirm>
      )}
    </Card>
  );
}
