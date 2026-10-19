import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ReaBridge, ResultFile, Target } from '../shared/types';
import { highlightedLine, previewCode } from './result-model';

const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
export function ResultsPanel({ bridge, target, busy }: { bridge?: ReaBridge; target?: Target; busy: boolean }) {
  const [files, setFiles] = useState<ResultFile[]>([]);
  const [scope, setScope] = useState(target?.path ?? '');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{ file: ResultFile; text?: string; truncated: boolean }>();
  const [view, setView] = useState('Description');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [limit, setLimit] = useState(100);
  const request = useRef(0);
  const available = !!bridge?.listResults && !!bridge?.readResult;
  const refresh = useCallback(async () => {
    if (!bridge?.listResults) return;
    try { setFiles(await bridge.listResults()); } catch (issue) { setError(String(issue)); }
  }, [bridge]);
  useEffect(() => { void refresh(); return bridge?.onEvent(event => { if (event.phase === 'results') { void refresh(); if (Array.isArray(event.warnings) && event.warnings.length) setError(event.warnings.join('\n')); } }); }, [bridge, refresh]);
  useEffect(() => { setScope(target?.path ?? ''); setSelected(undefined); setLoading(false); ++request.current; }, [target?.path]);
  useEffect(() => { setLimit(100); setSelected(undefined); setLoading(false); ++request.current; }, [scope, query]);
  useEffect(() => () => { ++request.current; }, []);
  const cases = Array.from(new Map(files.map(file => [file.targetPath, file.targetName])).entries());
  const matches = files.filter(file => (!scope || file.targetPath === scope) && `${file.name} ${file.targetName} ${file.description.summary} ${file.description.purpose} ${file.description.dependencies.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const open = async (file: ResultFile) => {
    if (!bridge?.readResult) return;
    const revision = ++request.current; setLoading(true); setSelected(undefined); setError('');
    try { const detail = await bridge.readResult(file.id); if (request.current === revision) { setSelected(detail); setView('Description'); } }
    catch (issue) { if (request.current === revision) setError(String(issue)); }
    finally { if (request.current === revision) setLoading(false); }
  };
  const action = async (kind: 'import' | 'export') => {
    if (!bridge) return;
    setWorking(true); setError(''); setNotice('');
    try {
      if (kind === 'import') { const result = await bridge.importResults?.(); if (result) { setNotice(`${result.saved} files saved. Existing identical files are kept once.`); if (result.warnings.length) setError(result.warnings.join('\n')); await refresh(); } }
      else { const result = await bridge.exportResults?.(scope ? { targetPath: scope } : {}); if (result) setNotice(`${result.count} files and descriptions exported to ${result.path}`); }
    } catch (issue) { setError(String(issue)); }
    finally { setWorking(false); }
  };
  const preview = previewCode(selected?.text ?? '');
  const d = selected?.file.description;
  return <section className="rea-results" aria-label="Saved Results library">
    <div className="rea-results-heading"><div><span className="rea-eyebrow">PERSISTENT RECOVERY LIBRARY</span><h1>Results</h1><p>Recovered files, explained in plain English. Saved locally across restarts.</p></div><div className="rea-results-actions"><button onClick={() => void refresh()} disabled={!available || working}>Refresh</button><button onClick={() => void action('import')} disabled={!bridge?.importResults || !target || busy || working} title="Choose an existing recovery folder for the selected target">Import folder</button><button className="rea-primary" onClick={() => void action('export')} disabled={!bridge?.exportResults || !matches.length || busy || working}>Export {scope ? 'target' : 'all'}</button></div></div>
    {!available && <p className="rea-results-alert" role="status">Restart the desktop app to load the Results bridge.</p>}
    {notice && <p className="rea-results-alert" role="status">{notice}</p>}
    {error && <p className="rea-results-alert error" role="alert">{error}</p>}
    <div className="rea-results-filters"><label>Target<select aria-label="Results target" value={scope} onChange={event => setScope(event.target.value)}><option value="">All saved targets</option>{target && !cases.some(([path]) => path === target.path) && <option value={target.path}>{target.name}</option>}{cases.map(([path, name]) => <option key={path} value={path}>{name} · {path}</option>)}</select></label><label>Search<input aria-label="Search saved Results" placeholder="Filename, behavior or dependency…" value={query} onChange={event => setQuery(event.target.value)}/></label><span>{matches.length} files</span></div>
    <div className="rea-results-layout"><div className="rea-results-list" role="region" aria-label="Saved recovered files" tabIndex={0}>
      {matches.slice(0, limit).map(file => <button key={file.id} className={selected?.file.id === file.id ? 'selected' : ''} onClick={() => void open(file)} aria-label={`Open result ${file.name}`}><span className="rea-results-file-name">{file.name}</span><span>{file.description.language} · {size(file.bytes)}</span><small>{file.targetName} · {file.kind.replaceAll('-', ' ')}</small></button>)}
      {matches.length > limit && <button onClick={() => setLimit(limit + 100)}>Load next 100 files</button>}
      {!matches.length && <div className="rea-results-empty"><h3>{query ? 'No matching files' : 'No saved files yet'}</h3><p>{query ? 'Try another filename or behavior.' : 'Decompiled code and recovered output folders are saved here automatically when a tool returns them. Select the original target and import a folder to include earlier recoveries.'}</p><p>Files not yet requested from the decompiler will appear after they are recovered.</p></div>}
    </div><article className="rea-results-detail" aria-label="Saved file details">
      {loading ? <div className="rea-results-empty">Checking saved file integrity…</div> : selected && d ? <><div className="rea-results-file-heading"><h2>{selected.file.name}</h2><span>{d.language} · {size(selected.file.bytes)}</span></div><div className="rea-results-detail-tabs" role="tablist" aria-label="Saved result views">{['Description', 'Code', 'Provenance'].map(tab => <button key={tab} role="tab" aria-selected={view === tab} className={view === tab ? 'active' : ''} onClick={() => setView(tab)}>{tab}</button>)}</div>
        <div className="rea-results-detail-body" role="region" aria-label={`${view} for ${selected.file.name}`} tabIndex={0}>
          {view === 'Description' ? <><p className="rea-results-summary">{d.summary}</p><h3>Purpose and behavior</h3><p>{d.purpose}</p><h3>Observed behavior</h3>{d.observations.length ? d.observations.map((item, index) => <div className="rea-results-observation" key={index}><p>{item.explanation}</p><code>Line {item.line}: {item.text}</code></div>) : <p>No specific behavior was established by the local inspection.</p>}<h3>Routines and inputs</h3>{d.functions.length ? d.functions.map((item, index) => <div className="rea-results-observation" key={index}><strong>{item.name} · line {item.line}</strong><p>{item.explanation}</p></div>) : <p>No routine declarations were recognized.</p>}<h3>Dependencies</h3><p>{d.dependencies.length ? d.dependencies.join(', ') : 'No dependency declarations were recognized.'}</p><h3>What remains uncertain</h3><ul>{d.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul><span className="rea-results-local">LOCAL STATIC EXPLANATION · NO CODE EXECUTION</span></> : view === 'Code' ? selected.text !== undefined ? <>{(preview.truncated || selected.truncated) && <p className="rea-preview-limit">Preview is limited. Export Results to read the complete saved file.</p>}<div className="rea-code-lines">{preview.lines.map((line, index) => <div key={index}><span className="rea-line-number">{index + 1}</span><code>{highlightedLine(line.text).map((token, index) => <span key={index} className={token.kind ? `rea-token-${token.kind}` : undefined}>{token.text}</span>)}{line.truncated && '…'}</code></div>)}</div></> : <p>This binary artifact has no text preview. Export Results to inspect its complete bytes.</p> : <dl className="rea-results-provenance"><dt>Target</dt><dd>{selected.file.targetPath}</dd><dt>Produced by</dt><dd>{selected.file.operation}</dd><dt>Original output / code identity</dt><dd>{selected.file.sourcePath}</dd><dt>Saved copy</dt><dd>{selected.file.storedPath}</dd><dt>Saved on</dt><dd>{new Date(selected.file.savedAt).toLocaleString()}</dd><dt>SHA-256</dt><dd>{selected.file.sha256}</dd><dt>Evidence</dt><dd>{selected.file.evidenceId || 'Imported file; no REA Evidence identity attached.'}</dd></dl>}
        </div></> : <div className="rea-results-empty"><h3>Select a recovered file</h3><p>Read its explanation, inspect the saved code, or check its origin and integrity.</p></div>}
    </article></div>
  </section>;
}
