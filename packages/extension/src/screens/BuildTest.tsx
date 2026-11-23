import { useEffect, useRef, useState } from 'react';
import { analyzeLog, type CommandSafety, type LogAnalysis, type PreparedCommand, type RunRecord, type RunResult, type ToolchainInfo } from '@repomind/core';
import { useActive, useStore } from '../lib/store';
import { Badge, Button, Card, Confirm, Empty, Kv } from '../components/ui';
import { engine } from '../lib/engine';
import { db } from '../lib/db';
import { rid, timeAgo } from '../lib/util';

interface StoredRun extends RunRecord {
  projectId: string;
  taskId?: string;
}

export function BuildTest() {
  const s = useStore();
  const a = useActive();
  const [commands, setCommands] = useState<PreparedCommand[] | null>(null);
  const [toolchains, setToolchains] = useState<ToolchainInfo[]>([]);
  const [custom, setCustom] = useState('');
  const [customCwd, setCustomCwd] = useState('');
  const [safety, setSafety] = useState<CommandSafety | null>(null);
  const [pending, setPending] = useState<PreparedCommand | null>(null);
  const [running, setRunning] = useState<{ cmd: PreparedCommand; runId?: string; out: string } | null>(null);
  const [result, setResult] = useState<{ run: RunResult; analysis: LogAnalysis; label: string } | null>(null);
  const [history, setHistory] = useState<StoredRun[]>([]);
  const [loading, setLoading] = useState(false);
  const termRef = useRef<HTMLPreElement>(null);
  const task = a.tasks.find((t) => t.id === s.activeTaskId);
  const pid = a.project.engine?.projectId;
  const connected = s.engineState.status === 'connected';

  const detect = async () => {
    if (!pid) return;
    setLoading(true);
    try {
      const r = await engine.call('commands.detect', { projectId: pid });
      setCommands(r.commands);
      setToolchains(r.toolchains);
    } catch (e) {
      s.toast((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (connected && pid) void detect();
    void db.all<StoredRun>('runs').then((rs) => setHistory(rs.filter((r) => r.projectId === a.project.id).sort((x, y) => y.startedAt.localeCompare(x.startedAt)).slice(0, 30)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, pid]);

  useEffect(() => {
    termRef.current?.scrollTo({ top: termRef.current.scrollHeight });
  }, [running?.out]);

  if (a.project.source !== 'local-engine') {
    return <Card><Empty title="Local projects only">Build and test commands run on your machine through the local engine. Open this repository as a local folder (Repositories → Open a local folder).</Empty></Card>;
  }
  if (!connected) {
    return <Card><Empty title="Engine not connected" action={<Button onClick={() => void s.connectEngine()}>Connect</Button>}>{s.engineState.status === 'disconnected' ? s.engineState.error : 'Connecting…'}</Empty></Card>;
  }

  const prepareCustom = async () => {
    try {
      const r = await engine.call('commands.prepare', { projectId: pid!, commandLine: custom, cwd: customCwd || undefined });
      setSafety(r.safety);
      if (r.command) setPending(r.command);
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  const run = async (cmd: PreparedCommand) => {
    setPending(null);
    setResult(null);
    setRunning({ cmd, out: '' });
    const display = cmd.argv.join(' ');
    try {
      const r = await engine.call(
        'commands.run',
        { projectId: pid!, token: cmd.token, approved: true },
        {
          onEvent: (e) => {
            if (e.event === 'progress' && e.data.message?.startsWith('run-started:')) {
              const runId = e.data.message.slice(12);
              setRunning((x) => (x ? { ...x, runId } : x));
            } else if (e.event === 'output' && e.data.text) setRunning((x) => (x ? { ...x, out: (x.out + e.data.text).slice(-60000) } : x));
          }
        }
      );
      const analysis = analyzeLog(`${r.stdout}\n${r.stderr}`, a.project.engine!.root);
      setResult({ run: r, analysis, label: cmd.label });
      const rec: StoredRun = {
        id: rid('run'),
        projectId: a.project.id,
        taskId: task?.id,
        label: cmd.label,
        command: display,
        cwd: r.cwd,
        status: r.status,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        startedAt: r.startedAt,
        excerpt: analysis.excerpt.length > 200 ? analysis.excerpt : `${r.stdout}\n${r.stderr}`.slice(-20000),
        diagnostics: analysis.diagnostics.filter((d) => d.severity === 'error').length,
        failedTests: analysis.failedTests.length,
        truncated: r.truncated
      };
      await db.put('runs', rec.id, rec);
      setHistory((h) => [rec, ...h].slice(0, 30));
      if (task) await s.saveTask({ ...task, runs: [...task.runs, rec] });
      s.log('run', `${display} → ${r.status}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}`);
      s.toast(`${cmd.label}: ${r.status.toUpperCase()}`, r.status === 'passed' ? 'success' : 'error');
      if (s.settings.notifications && chrome.notifications) {
        chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: `RepoMind: ${cmd.label}`, message: `${r.status.toUpperCase()} in ${(r.durationMs / 1000).toFixed(0)} s` });
      }
    } catch (e) {
      s.toast((e as Error).message, 'error');
    } finally {
      setRunning(null);
      void detect(); // tokens are single-use: refresh them
    }
  };

  const groups = ['test', 'build', 'check', 'typecheck', 'lint'] as const;
  return (
    <div className="stack">
      {task && <div className="callout">Results will be recorded on task <strong>{task.title}</strong>.</div>}
      <Card title="Toolchains" actions={<Button small icon="refresh" busy={loading} onClick={() => void detect()}>Re-detect</Button>}>
        <div className="row gap-xs">
          {toolchains.map((t) => <Badge key={t.name} tone={t.available ? 'ok' : 'neutral'} title={t.path}>{t.name}{t.version ? ` ${t.version}` : ''}{t.available ? '' : ' ✕'}</Badge>)}
        </div>
      </Card>

      <Card title="Detected commands" subtitle="Nothing runs without your confirmation. Commands are executed directly (no shell), never with sudo, with a timeout and output limit.">
        {commands === null ? <p className="muted small">Detecting…</p> : commands.length === 0 ? <p className="muted small">No build system detected. Add a custom command below.</p> : null}
        {groups.map((g) => {
          const list = commands?.filter((c) => c.category === g) ?? [];
          if (!list.length) return null;
          return (
            <div key={g} className="stack-sm">
              <strong className="small" style={{ textTransform: 'capitalize' }}>{g}</strong>
              {list.map((c) => (
                <div key={c.token} className="card subtle">
                  <div className="row nowrap spread">
                    <strong className="truncate">{c.label}</strong>
                    <Button small variant="primary" icon="play" disabled={!c.available || Boolean(running)} onClick={() => setPending(c)} title={c.available ? 'Review and run' : `${c.requires} not found`}>Run…</Button>
                  </div>
                  <code className="break">{c.argv.join(' ')}</code>
                  <div className="row gap-xs">
                    {!c.available && <Badge tone="bad">{c.requires} missing</Badge>}
                    {c.mayDownload && <Badge tone="warn">may download</Badge>}
                    {c.mayModifyFiles && <Badge tone="info">writes files</Badge>}
                    <span className="muted small">{c.description}</span>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </Card>

      <Card title="Custom command" subtitle="For commands DeepSeek suggested: review them, type them here yourself. Shell syntax (pipes, &&, $(…)) is rejected.">
        <div className="row nowrap">
          <input className="input grow mono" placeholder="./gradlew :app:testDebugUnitTest --tests com.example.*" value={custom} onChange={(e) => { setCustom(e.target.value); setSafety(null); }} />
          <input className="input mono" style={{ width: 110 }} placeholder="cwd (rel.)" value={customCwd} onChange={(e) => setCustomCwd(e.target.value)} />
          <Button disabled={!custom.trim()} onClick={() => void prepareCustom()}>Check</Button>
        </div>
        {safety && !safety.ok && <div className="callout bad">{safety.errors.join(' ')}</div>}
        {safety && safety.warnings.length > 0 && <div className="callout warn">{safety.warnings.join(' ')}</div>}
      </Card>

      {running && (
        <Card title={`Running: ${running.cmd.label}`} actions={running.runId && <Button small variant="danger" icon="stop" onClick={() => void engine.call('commands.cancel', { runId: running.runId! })}>Cancel</Button>}>
          <code>{running.cmd.argv.join(' ')}</code>
          <pre className="terminal" ref={termRef}>{running.out || 'Waiting for output…'}</pre>
        </Card>
      )}

      {result && <RunResultView result={result} />}

      <Card title="Execution history">
        {history.length === 0 ? <p className="muted small">No runs yet.</p> : (
          <div className="list">
            {history.map((h) => (
              <details key={h.id} className="list-item" style={{ display: 'block' }}>
                <summary className="row nowrap">
                  <Badge tone={h.status === 'passed' ? 'ok' : h.status === 'failed' ? 'bad' : 'warn'}>{h.status}</Badge>
                  <span className="mono small grow truncate">{h.command}</span>
                  <span className="muted small">{(h.durationMs / 1000).toFixed(1)} s · {timeAgo(h.startedAt)}</span>
                </summary>
                <pre className="terminal" style={{ marginTop: 6 }}>{h.excerpt}</pre>
              </details>
            ))}
          </div>
        )}
      </Card>

      {pending && (
        <Confirm title="Run this command?" confirmLabel="Run" onCancel={() => setPending(null)} onConfirm={() => run(pending)}>
          <Kv
            rows={[
              ['Command', <code key="c" className="break">{pending.argv.join(' ')}</code>],
              ['Directory', <code key="d" className="break">{pending.absoluteCwd}</code>],
              ['What it does', pending.description],
              ['Network', pending.mayDownload ? 'May download dependencies' : 'Not expected'],
              ['Files', pending.mayModifyFiles ? 'May write files (e.g. build outputs)' : 'Not expected to modify files'],
              ['Timeout', `${Math.round(pending.timeoutMs / 60000)} min`]
            ]}
          />
          <p className="muted small">Runs without a shell and without elevated privileges. Output is captured locally.</p>
        </Confirm>
      )}
    </div>
  );
}

function RunResultView({ result }: { result: { run: RunResult; analysis: LogAnalysis; label: string } }) {
  const s = useStore();
  const a = useActive();
  const { run, analysis } = result;
  const task = a.tasks.find((t) => t.id === s.activeTaskId);
  return (
    <Card
      title={<span className="row nowrap">{result.label} <Badge tone={run.status === 'passed' ? 'ok' : run.status === 'failed' ? 'bad' : 'warn'}>{run.status}</Badge></span>}
      subtitle={`exit ${run.exitCode ?? '—'}${run.signal ? ` (${run.signal})` : ''} · ${(run.durationMs / 1000).toFixed(1)} s${run.timedOut ? ' · timed out' : ''}${run.cancelled ? ' · cancelled' : ''}${run.truncated ? ' · output truncated' : ''}`}
    >
      {analysis.summaryLine && <div className="callout">{analysis.summaryLine}</div>}
      {analysis.failingTasks.length > 0 && <div className="small">Failing tasks: <code>{analysis.failingTasks.join(', ')}</code></div>}
      {analysis.diagnostics.length > 0 && (
        <div className="list">
          {analysis.diagnostics.slice(0, 50).map((d, i) => (
            <div key={i} className="list-item clickable" onClick={() => d.file && a.index.files[d.file] && (s.setFocusFile(d.file), s.setScreen('explorer'))}>
              <Badge tone={d.severity === 'error' ? 'bad' : 'warn'}>{d.tool}</Badge>
              <span className="mono small truncate" style={{ maxWidth: 180 }}>{d.file?.split('/').pop()}:{d.line}</span>
              <span className="small grow break">{d.message}</span>
            </div>
          ))}
        </div>
      )}
      {analysis.failedTests.length > 0 && <ul className="bullets small">{analysis.failedTests.map((t, i) => <li key={i}>{t.name}{t.message ? ` — ${t.message}` : ''}</li>)}</ul>}
      <details>
        <summary className="small">Relevant output (noise removed)</summary>
        <pre className="terminal">{analysis.excerpt}</pre>
      </details>
      <details>
        <summary className="small">Raw output</summary>
        <pre className="terminal">{`${run.stdout}\n${run.stderr}`.trim() || '(no output)'}</pre>
      </details>
      {run.status !== 'passed' && task && (
        <Button variant="primary" onClick={() => { void s.saveTask({ ...task, stage: 'correct' }); s.setScreen('workflow'); }}>Build correction prompt for “{task.title}”</Button>
      )}
    </Card>
  );
}
