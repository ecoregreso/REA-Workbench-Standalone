import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import type { EngineEvent, EngineStatus, ReaBridge, ReaResult, ReaTool, Target } from '../shared/types';
import { ToolForm } from './ToolForm';
import { MarkdownViewer } from './MarkdownViewer';
import { ResultsPanel } from './ResultsPanel';
import { argumentsFor, availabilitySummary, codeFrom, entriesFrom, healthRows, highlightedLine, missingRequired, modulesForTree, operationFrom, partialAnalysis, previewCode, profileForTarget, readable, resolveSchema, resultLimitations, stripControls, symbolsFrom, toolFor, unpack } from './result-model';
import type { Profile, RecordEntry, SymbolEntry } from './result-model';
import './workspace.css';

type ProviderSetting = { id: string; label: string; path: string; kind: 'file' | 'directory'; environmentKey: string; description: string; overridden: boolean };
type SettingsBridge = ReaBridge & { providerSettings?: () => Promise<ProviderSetting[]>; chooseProviderSetting?: (id: string) => Promise<ProviderSetting[] | null>; clearProviderSetting?: (id: string) => Promise<ProviderSetting[]> };

const emptyStatus: EngineStatus = { connected: false, toolCount: 0, busy: false, tools: [] };
const profiles: Profile[] = ['Native', 'JavaScript', 'Go', '.NET', 'Android'];
const profileTitles: Record<Profile, string> = { Native: 'Native binary', JavaScript: 'JavaScript / Electron', Go: 'Go binary', '.NET': 'Managed artifact', Android: 'Android package' };
const profileDescriptions: Record<Profile, string> = { Native: 'Inspect procedures, disassembly and cross references.', JavaScript: 'Trace modules, entry points and application structure.', Go: 'Inspect native procedures through the selected binary provider.', '.NET': 'Inspect assemblies, metadata and managed code.', Android: 'Inspect package metadata, code and resources.' };

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    file: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></>,
    folder: <path d="M3 6h7l2 2h9v12H3z"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    activity: <path d="M2 12h5l3-8 4 16 3-8h5"/>,
    connect: <><path d="M8 3v5M16 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/></>,
    tools: <><path d="m4 20 9-9M14 3a6 6 0 0 0-3 8 6 6 0 0 0 8-3l-4 1-2-2z"/><circle cx="5" cy="19" r="2"/></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/></>,
    shield: <><path d="m12 3 9 4v6c0 5-9 9-9 9S3 18 3 13V7z"/><path d="m8 12 3 3 5-6"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.code}</svg>;
}
function Empty({ title, detail, icon = 'code' }: { title: string; detail: string; icon?: string }) { return <div className="rea-empty"><div className="rea-empty-icon"><Icon name={icon} size={24}/></div><h3>{title}</h3><p>{detail}</p></div>; }
function byteSize(bytes?: number) { if (bytes === undefined) return 'Size unavailable'; return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
function timeLabel(at: string) { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

function OutputConsole({ events }: { events: EngineEvent[] }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const lastWritten = useRef<EngineEvent>();
  useEffect(() => {
    if (!container.current) return;
    const instance = new Terminal({ disableStdin: true, cursorBlink: false, fontSize: 11.5, fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, monospace', theme: { background: '#111a21', foreground: '#bdccd7', cursor: '#111a21', selectionBackground: '#3c4654' }, rows: 6, cols: 100, scrollback: 2000, convertEol: true });
    instance.open(container.current); terminal.current = instance;
    instance.writeln('REA engine output · read only');
    const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width || 600; instance.resize(Math.max(20, Math.floor((width - 16) / 7)), 6); });
    observer.observe(container.current);
    lastWritten.current = undefined;
    return () => { observer.disconnect(); instance.dispose(); terminal.current = undefined; };
  }, []);
  useEffect(() => {
    if (!terminal.current) return;
    const previousIndex = lastWritten.current ? events.indexOf(lastWritten.current) : -1;
    for (const event of events.slice(previousIndex + 1)) terminal.current.writeln(`[${timeLabel(event.timestamp)}] ${stripControls(event.text || event.type)}`);
    lastWritten.current = events[events.length - 1];
  }, [events]);
  return <div className="rea-terminal" ref={container} role="region" aria-label="Read only REA engine output" />;
}

export function Workspace({ bridge: suppliedBridge }: { bridge?: ReaBridge }) {
  const bridge = suppliedBridge ?? window.reaWorkbench;
  const [status, setStatus] = useState<EngineStatus>(emptyStatus);
  const [loadingStatus, setLoadingStatus] = useState(!!bridge);
  const [target, setTarget] = useState<Target>();
  const [profile, setProfile] = useState<Profile>('Native');
  const [provider, setProvider] = useState('auto');
  const [javascriptHeap, setJavascriptHeap] = useState('auto');
  const [records, setRecords] = useState<RecordEntry[]>([]);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [currentId, setCurrentId] = useState<string>();
  const [symbols, setSymbols] = useState<SymbolEntry[]>([]);
  const [symbolQuery, setSymbolQuery] = useState('');
  const [selectedSymbol, setSelectedSymbol] = useState<SymbolEntry>();
  const [view, setView] = useState('Pseudocode');
  const [section, setSection] = useState('Analysis');
  const [rail, setRail] = useState('Evidence');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [selectedToolName, setSelectedToolName] = useState('');
  const [toolQuery, setToolQuery] = useState('');
  const [seedOverride, setSeedOverride] = useState<Record<string, any>>();
  const [stringsQuery, setStringsQuery] = useState('');
  const [lookupKind, setLookupKind] = useState<'strings' | 'xrefs'>('strings');
  const [lookupResult, setLookupResult] = useState<ReaResult>();
  const [modules, setModules] = useState<any[]>([]);
  const [moduleEvidence, setModuleEvidence] = useState('');
  const [moduleSourceRoot, setModuleSourceRoot] = useState('');
  const [moduleNextOffset, setModuleNextOffset] = useState<number>();
  const [selectedModule, setSelectedModule] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const [note, setNote] = useState('');
  const [inferences, setInferences] = useState<Array<{ text: string; sourceId?: string; at: string }>>([]);
  const [dialog, setDialog] = useState<{ title: string; text: string; dossier?: boolean; health?: any; settings?: ProviderSetting[]; copyText?: string }>();
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState('');
  const [dossier, setDossier] = useState<string>();
  const [dragActive, setDragActive] = useState(false);
  const runCounter = useRef(0);
  const current = records.find(record => record.id === currentId);
  const tools = status.tools || [];
  const pending = !!busy || status.busy;
  const usable = !!bridge && status.connected && !pending;
  const selectedTool = tools.find(tool => tool.name === selectedToolName);
  const filteredTools = tools.filter(tool => `${tool.name} ${tool.description || ''}`.toLowerCase().includes(toolQuery.toLowerCase()));
  const filteredSymbols = symbols.filter(symbol => `${symbol.name} ${symbol.address || ''}`.toLowerCase().includes(symbolQuery.toLowerCase()));
  const toolSeed = useMemo(() => {
    if (!selectedTool) return {};
    const seed = { ...(seedOverride ?? argumentsFor(selectedTool, target, selectedSymbol, undefined, records)) };
    const properties = resolveSchema(selectedTool.inputSchema, selectedTool.inputSchema).properties || {};
    if (selectedTool.name === 'analyze_javascript_application' && !seedOverride) seed.detail = 'summary';
    if (status.outputDirectory) {
      if (properties.output_directory && !seed.output_directory) seed.output_directory = `${status.outputDirectory}/${selectedTool.name}-${Date.now()}`;
      if (selectedTool.name === 'export_evidence_bundle') seed.path = `${status.outputDirectory}/evidence-${Date.now()}.json`;
    }
    return seed;
  }, [selectedTool?.name, target?.id, selectedSymbol, records, seedOverride, status.outputDirectory]);
  const providerTool = tools.find(tool => tool.name === 'open_binary');
  const providerProperties = providerTool ? resolveSchema(providerTool.inputSchema, providerTool.inputSchema).properties || {} : {};
  const providerSchema = providerTool ? resolveSchema(providerProperties.provider_id ?? providerProperties.providerId, providerTool.inputSchema) : {};
  const providerValues: string[] = providerSchema.enum || ['auto', 'hopper', 'ghidra', 'ida'];
  const analysisTool = toolFor(tools, 'analyze', profile);
  const missingBridge = !bridge;
  const code: string = view === 'Source' && current?.name === 'readArtifact' ? typeof current.result.text === 'string' ? current.result.text : '' : codeFrom(current?.result, view);
  const codePreview = useMemo(() => previewCode(code), [code]);
  const selectedScript = !!target && target.kind === 'file' && /\.(js|mjs|cjs|ts|mts|cts|tsx|jsx)$/i.test(target.name);
  const readiness = availabilitySummary(tools);
  const analysisNotice = useMemo(() => partialAnalysis(records.slice().reverse().find(record => record.name === 'analyze_javascript_application')?.result), [records]);
  const lookupEntries = entriesFrom(lookupResult, lookupKind);

  const pushEvent = useCallback((text: string, type: EngineEvent['type'] = 'log') => setEvents(previous => [...previous, { type, text, timestamp: new Date().toISOString() }].slice(-1000)), []);
  const refresh = useCallback(async () => { if (!bridge) return; const next = await bridge.status(); setStatus(next); if (next.target) setTarget(next.target); return next; }, [bridge]);
  useEffect(() => {
    if (!bridge) { setStatus(emptyStatus); setLoadingStatus(false); return; }
    let active = true;
    bridge.status().then(next => { if (active) { setStatus(next); if (next.target) { setTarget(next.target); setProfile(profileForTarget(next.target)); } } }).catch(issue => { if (active) setError(String(issue)); }).finally(() => { if (active) setLoadingStatus(false); });
    const unsubscribe = bridge.onEvent(event => { if (active) { setEvents(previous => [...previous, event].slice(-1000)); if (event.phase === 'results' && Array.isArray(event.warnings) && event.warnings.length) setError(event.warnings.join('\n')); if (event.type === 'status') bridge.status().then(next => { if (active) setStatus(next); }).catch(() => {}); } });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);

  function addRecord(name: string, args: Record<string, any>, result: ReaResult) {
    const entry: RecordEntry = { id: String(++runCounter.current), name, at: new Date().toISOString(), arguments: args, result };
    setRecords(previous => [...previous, entry].slice(-200)); setCurrentId(entry.id);
    setView(name === 'readArtifact' || codeFrom(result, 'Source') ? 'Source' : codeFrom(result, 'Pseudocode') ? 'Pseudocode' : codeFrom(result, 'Assembly') ? 'Assembly' : 'Raw result');
    const found = symbolsFrom(result, name); if (found.length) setSymbols(found);
    const foundModules = entriesFrom(result, 'modules'); if (foundModules.length && name !== 'inspect_analysis_view') setModules(foundModules);
    return entry;
  }
  async function connect() {
    if (!bridge) return;
    setBusy('Connecting to REA'); setError('');
    try { const next = await bridge.connect(); setStatus(next); pushEvent(`Engine connected · ${next.toolCount} tools advertised`); }
    catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); pushEvent(String(issue)); }
    finally { setBusy(''); await refresh().catch(() => {}); }
  }
  async function runTool(tool: ReaTool, args: Record<string, any>): Promise<ReaResult | undefined> {
    if (!bridge || !status.connected || pending) return;
    setBusy(tool.name); setError(''); pushEvent(`Running ${tool.name}`);
    try {
      const result = await bridge.callTool({ name: tool.name, arguments: args });
      addRecord(tool.name, args, result);
      if (result.isError) { setError(readable(result)); pushEvent(`${tool.name} returned an error`); }
      else pushEvent(`${tool.name} completed`);
      return result;
    } catch (issue) { const message = issue instanceof Error ? issue.message : String(issue); setError(message); pushEvent(message); return undefined; }
    finally { setBusy(''); await refresh().catch(() => {}); }
  }
  function showTool(tool: ReaTool, seed?: Record<string, any>) { setSelectedToolName(tool.name); setSeedOverride(seed); setRail('MCP / Tools'); }
  async function operation(name: string, symbol = selectedSymbol, query?: string) {
    const tool = toolFor(tools, name, profile);
    if (!tool) { setError(`The connected engine does not advertise a tool for ${name}. Browse MCP / Tools for available capabilities.`); return; }
    if (tool.available === false) { setError(tool.reason || `${tool.name} is unavailable.`); showTool(tool); return; }
    const args = argumentsFor(tool, target, symbol, query, records);
    const missing = missingRequired(tool, args);
    if (missing.length) { showTool(tool, args); setError(`${tool.name} requires ${missing.join(', ')}. Complete the advertised arguments in MCP / Tools.`); return; }
    const result = await runTool(tool, args);
    if (!result || result.isError) return;
    if (name === 'strings' || name === 'xrefs') { setLookupKind(name); setLookupResult(result); setRail('Xrefs / Strings'); }
    if (name === 'dossier') { const markdown = readable(result); setDossier(markdown); setDialog({ title: 'Analysis dossier', text: markdown, dossier: true }); }
    if (name === 'analyze' && profile === 'JavaScript') { const envelope = unpack(result); if (typeof envelope?.parameters?.input_path === 'string') setModuleSourceRoot(envelope.parameters.input_path); const evidenceId = envelope?.normalized_result?.parent_evidence_id ?? envelope?.evidence_id; if (evidenceId) { setModuleEvidence(String(evidenceId)); await loadModules(String(evidenceId), 0); } }
    if (name === 'assembly') setView('Assembly');
    if (name === 'decompile') setView('Pseudocode');
  }
  async function choose(kind: 'file' | 'directory') {
    if (!bridge || pending) return;
    setError('');
    try { const chosen = await bridge.chooseTarget(kind); if (chosen) acceptTarget(chosen); }
    catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
  }
  function acceptTarget(chosen: Target) {
    setModuleEvidence(''); setModuleSourceRoot(''); setModuleNextOffset(undefined); setSelectedModule(''); setTarget(chosen); setSymbols([]); setSelectedSymbol(undefined); setModules([]); setCurrentId(undefined); setLookupResult(undefined); setDossier(undefined); setRecords([]); setInferences([]);
    setProfile(profileForTarget(chosen));
    pushEvent(`Selected ${chosen.name}`);
  }
  async function drop(event: React.DragEvent) {
    event.preventDefault(); setDragActive(false);
    if (!bridge || pending) return;
    const file = event.dataTransfer.files[0];
    const dropBridge = bridge as ReaBridge & { chooseDroppedTarget?: (file: File) => Promise<Target | null> };
    if (file && dropBridge.chooseDroppedTarget) {
      try { const chosen = await dropBridge.chooseDroppedTarget(file); if (chosen) acceptTarget(chosen); } catch (issue) { setError(String(issue)); }
    } else await choose('file');
  }
  async function openTarget() {
    if (!bridge || !target || pending) return;
    setBusy('Inspecting target'); setError('');
    try {
      if (selectedScript && typeof target.size === 'number' && target.size <= 2 * 1024 * 1024) {
        try {
          const artifact = await bridge.readArtifact(target.path);
          addRecord('readArtifact', { path: target.path, original_path: target.path, source_scope: 'selected-file-only' }, artifact);
          pushEvent(`Read selected source · ${target.name}`);
        } catch (issue) {
          pushEvent(`Static source preview unavailable: ${issue instanceof Error ? issue.message : String(issue)}`);
        }
      }
      const result = await bridge.openTarget({ targetId: target.id, providerId: provider, ...(profile === 'JavaScript' && javascriptHeap !== 'auto' ? {maxHeapMb: Number(javascriptHeap)} : {}) });
      const name = operationFrom(result);
      const envelope = unpack(result);
      const entry = addRecord(name, envelope?.parameters ?? { targetId: target.id, providerId: provider }, result);
      if (result.isError) { setError(readable(result)); return; }
      pushEvent(`${name} completed for ${target.name}`);
      const freshStatus = await refresh();
      if (name === 'analyze_javascript_application') {
        const sourceRoot = result.meta?.sourceRoot ?? result.meta?.analysisInputPath ?? envelope?.parameters?.input_path;
        if (typeof sourceRoot === 'string') setModuleSourceRoot(sourceRoot);
        const evidenceId = envelope?.normalized_result?.parent_evidence_id ?? envelope?.evidence_id;
        if (evidenceId) { setModuleEvidence(String(evidenceId)); await loadModules(String(evidenceId), 0); }
      } else if (name === 'open_binary') {
        const listTool = toolFor(freshStatus?.tools || tools, 'functions');
        if (listTool && listTool.available !== false) {
          const args = argumentsFor(listTool, target, undefined, undefined, [...records, entry]);
          if (!missingRequired(listTool, args).length) { setBusy(listTool.name); const list = await bridge.callTool({ name: listTool.name, arguments: args }); addRecord(listTool.name, args, list); if (list.isError) setError(readable(list)); }
        }
      }
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(''); await refresh().catch(() => {}); }
  }
  async function selectSymbol(symbol: SymbolEntry) { setSelectedSymbol(symbol); await operation('decompile', symbol); }
  async function inspectSystem(kind: 'doctor' | 'mcpConfig') {
    if (!bridge || pending) return;
    setBusy(kind === 'doctor' ? 'Checking system' : 'Reading MCP configuration'); setError(''); setCopiedConfig(false);
    try { const value = await bridge[kind](); setDialog({ title: kind === 'doctor' ? 'System health' : 'MCP configuration', text: JSON.stringify(value, null, 2), ...(kind === 'doctor' ? { health: value } : { copyText: JSON.stringify(value.configuration, null, 2) }) }); }
    catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(''); }
  }
  async function openSettings() {
    const settingsBridge = bridge as SettingsBridge | undefined;
    if (!settingsBridge?.providerSettings || pending) return;
    setBusy('Reading provider settings'); setError(''); setSettingsNotice('');
    try { const settings = await settingsBridge.providerSettings(); setDialog({ title: 'Engine & provider settings', text: '', settings }); }
    catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(''); }
  }
  async function updateSetting(id: string, action: 'choose' | 'clear') {
    const settingsBridge = bridge as SettingsBridge | undefined;
    const method = action === 'choose' ? settingsBridge?.chooseProviderSetting : settingsBridge?.clearProviderSetting;
    if (!method || pending) return;
    setBusy(action === 'choose' ? 'Choosing provider location' : 'Clearing provider setting'); setSettingsNotice('');
    try {
      const settings = await method.call(settingsBridge, id);
      if (!settings) return;
      setDialog(previous => previous ? { ...previous, settings } : previous);
      await refresh();
      setSettingsNotice('Setting saved. Reconnect the engine to apply it, then run System health to verify availability.');
      pushEvent('Provider setting saved; reconnect to apply and verify.');
    } catch (issue) { setSettingsNotice(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(''); }
  }
  async function previewDossier() {
    if (!bridge || pending) return;
    const extended = bridge as ReaBridge & { previewDossier?: () => Promise<{ path: string; markdown: string }> };
    if (!extended.previewDossier) { if (selectedSymbol) await operation('dossier'); else setError('This desktop bridge does not support portable dossier preview. Choose a native procedure or inspect the complete result records.'); return; }
    setBusy('Preparing dossier');
    try { const result = await extended.previewDossier(); if (!result) return; setDossier(result.markdown); setDialog({ title: 'Analysis dossier', text: result.markdown, dossier: true }); }
    catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(''); }
  }
  async function exportPdf() {
    const extended = bridge as ReaBridge & { exportPdf?: () => Promise<{ path: string } | null> };
    if (!extended?.exportPdf) return;
    setBusy('Saving PDF');
    try { const result = await extended.exportPdf(); if (result) { pushEvent(`PDF saved to ${result.path}`); setDialog({ title: 'PDF saved', text: result.path }); } }
    catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(''); }
  }
  async function exportDossier() {
    if (!bridge) return;
    setBusy('Saving dossier');
    try { const result = await bridge.exportDossier(); if (result) { pushEvent(`Dossier saved to ${result.path}`); setDialog({ title: 'Dossier saved', text: `${result.path}\n\n${result.markdown}`, dossier: true }); } }
    catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(''); }
  }
  async function loadModules(evidenceId: string, offset: number) {
    if (!bridge) return;
    const freshStatus = await bridge.status();
    setStatus(freshStatus);
    const tool = freshStatus.tools.find(item => item.name === 'inspect_analysis_view');
    if (!tool || tool.available === false) { if (tool?.reason) pushEvent(tool.reason); return; }
    const args = { source: { kind: 'retained-evidence', evidence_id: evidenceId }, view: { kind: 'page', collection: 'modules', offset, limit: 32 } };
    setBusy('Loading module graph');
    try {
      const result = await bridge.callTool({ name: tool.name, arguments: args });
      addRecord(tool.name, args, result);
      if (result.isError) { setError(readable(result)); return; }
      const data = unpack(result)?.normalized_result ?? unpack(result)?.result ?? unpack(result);
      const items = Array.isArray(data?.items) ? data.items : [];
      setModules(previous => offset ? [...previous, ...items] : items);
      const next = data?.coverage?.next_offset;
      setModuleNextOffset(typeof next === 'number' && !data?.coverage?.exhausted ? next : undefined);
      setView('Raw result');
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(''); await refresh().catch(() => {}); }
  }
  async function readSelectedSource() {
    if (!bridge || !target || !selectedScript || pending) return;
    const analyzed = records.slice().reverse().find(record => record.result.meta?.source?.scope === 'selected-file-only' && record.result.meta.source.path === target.path);
    const stagedPath = analyzed?.result.meta?.source?.stagedPath;
    const path = typeof stagedPath === 'string' ? stagedPath : target.path;
    setBusy('Reading selected source'); setError('');
    try {
      const artifact = await bridge.readArtifact(path);
      addRecord('readArtifact', { path, original_path: target.path, source_scope: 'selected-file-only' }, artifact);
      setView('Source');
      pushEvent(`Read ${stagedPath ? 'analyzed source snapshot' : 'selected source'}: ${target.name}`);
    } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); }
    finally { setBusy(''); }
  }
  async function inspectModule(module: any) {
    if (!bridge || !module.node_id || !moduleEvidence || pending) return;
    const tool = tools.find(item => item.name === 'inspect_analysis_view');
    if (!tool) return;
    setSelectedModule(module.node_id); setSelectedSymbol(undefined);
    const args = { source: { kind: 'retained-evidence', evidence_id: moduleEvidence }, view: { kind: 'item', collection: 'modules', selector: { node_id: module.node_id } } };
    const result = await runTool(tool, args);
    if (!result || result.isError) return;
    if (codeFrom(result, 'Source')) { setView('Source'); return; }
    if (!target || !module.path) { setView('Raw result'); return; }
    const path = /^(?:\/|[A-Za-z]:[\\/])/.test(module.path) ? module.path : `${(moduleSourceRoot || target.path).replace(/[\\/]$/, '')}/${module.path.replace(/^[\\/]/, '')}`;
    setBusy('Reading module source');
    try { const artifact = await bridge.readArtifact(path); addRecord('readArtifact', { path, node_id: module.node_id }, artifact); setView('Source'); }
    catch (issue) { setView('Raw result'); pushEvent(`Source unavailable for ${module.path}: ${issue instanceof Error ? issue.message : String(issue)}`); }
    finally { setBusy(''); }
  }
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') || []);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, [dialog]);
  const targetReady = !!target && usable;
  const canInspect = !!target && !!bridge && !pending && (!status.connected || (!!analysisTool && analysisTool.available !== false));
  const unavailable = tools.filter(tool => tool.available === false);
  const moduleRows = modulesForTree(modules);
  const moduleGroups = Array.from(new Set(moduleRows.map(module => module.path.split('/').slice(0, -1).join('/') || '.'))).map(folder => ({ folder, paths: Array.from(new Set(moduleRows.filter(module => (module.path.split('/').slice(0, -1).join('/') || '.') === folder).map(module => module.path))).map(path => ({ path, name: path.split('/').pop() || path, nodes: moduleRows.filter(module => module.path === path) })) }));
  const recordModuleId = current?.arguments?.node_id ?? current?.arguments?.view?.selector?.node_id;
  const recordModule = recordModuleId === undefined ? undefined : moduleRows.find(module => module.node_id === recordModuleId);
  const recordAddress = current?.arguments?.procedure ?? current?.arguments?.address ?? current?.arguments?.function_address;
  const recordSymbol = symbols.find(symbol => symbol.address === String(recordAddress));
  const recordLabel = (current?.name === 'readArtifact' ? current.arguments.original_path || current.result.path : undefined) || recordModule?.path || recordSymbol?.name || (recordAddress ? String(recordAddress) : current?.name) || 'No result selected';
  const residualUnknowns = resultLimitations(current?.result);
  const profileUnknowns = unavailable.filter(tool => profile === 'JavaScript' ? /javascript|electron|analysis_view|source_map|javascript_graph/.test(tool.name) : profile === '.NET' ? /managed|dotnet|clr|ilspy/.test(tool.name) : profile === 'Android' ? /android|apk|dex/.test(tool.name) && !/adb|device|logcat/.test(tool.name) : !/javascript|electron|managed|android|apk|dex|adb|device|logcat/.test(tool.name));
  const unknownReasons = Array.from(new Set(profileUnknowns.map(tool => tool.reason || `${tool.name} unavailable`)));


  return <div className={`rea-workspace${section === 'Results' ? ' rea-showing-results' : ''}`}>
    <header className="rea-header">
      <div className="rea-brand"><div className="rea-brand-mark"><Icon name="code" size={20}/></div><div><span className="rea-brand-name">REA<span className="rea-brand-slash"> / </span><span className="rea-brand-workbench">WORKBENCH</span></span><span className="rea-brand-caption">REVERSE ENGINEERING AGENT</span></div></div>
      <nav className="rea-workspace-sections" aria-label="Workbench sections">{['Analysis', 'Results'].map(item => <button key={item} aria-pressed={section === item} className={section === item ? 'active' : ''} onClick={() => setSection(item)}>{item}</button>)}</nav>
      <div className="rea-connection"><span className={`rea-status-dot${status.connected ? ' connected' : ''}`} /><span>{loadingStatus ? 'Checking engine' : status.connected ? 'Engine connected' : 'Engine offline'}</span>{status.connected && <span className="rea-tool-count">{readiness.advertised} tools · {readiness.ready} available</span>}</div>
      <div className="rea-header-actions"><button onClick={openSettings} disabled={!bridge || pending || !(bridge as SettingsBridge)?.providerSettings}><Icon name="tools"/>Settings</button><button onClick={() => inspectSystem('doctor')} disabled={!bridge || pending} title="Check engine and local adapters"><Icon name="activity"/>System health</button><button className={status.connected ? '' : 'rea-primary'} onClick={connect} disabled={!bridge || pending}><Icon name="connect"/>{status.connected ? 'Reconnect' : 'Connect engine'}</button></div>
    </header>
    {missingBridge && <div className="rea-bridge-notice" role="status"><Icon name="connect"/><div><strong>Open this workspace in the desktop app.</strong><span>The Electron bridge is unavailable in this browser. Local file access and REA tools require the desktop app.</span></div></div>}
    {error && <div className="rea-error-banner" role="alert"><span>{error}</span><button className="rea-icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close"/></button></div>}
    <div className={`rea-main-grid${section === 'Results' ? ' rea-results-active' : ''}`}>
      <aside className="rea-target-panel" aria-label="Target navigator">
        <div className="rea-panel-title"><h2>EXPLORER</h2><span className="rea-muted">LOCAL TARGET</span></div>
        <div className={`rea-target-drop${dragActive ? ' dragging' : ''}${target ? ' has-target' : ''}`} onDragOver={event => { event.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={drop}>
          <div className="rea-drop-heading"><Icon name={target?.kind === 'directory' ? 'folder' : 'file'} size={20}/><span>{target ? target.name : 'Choose a target'}</span></div>
          <p title={target?.path}>{target ? target.path : 'A binary, package or application folder. Files stay on your machine.'}</p>
          <div className="rea-target-actions"><button onClick={() => choose('file')} disabled={!bridge || pending}><Icon name="file"/>Choose file</button><button onClick={() => choose('directory')} disabled={!bridge || pending}><Icon name="folder"/>Folder</button></div>
          {!target && <span className="rea-drop-hint">or drop a local target here</span>}
        </div>
        <div className="rea-target-meta"><div><span>Target type</span><strong>{target ? target.kind : 'Not selected'}</strong></div><div><span>Size</span><strong>{byteSize(target?.size)}</strong></div>{profile === 'JavaScript' && <label><span>Analysis memory</span><select aria-label="JavaScript analysis memory" value={javascriptHeap} disabled={pending} onChange={event => setJavascriptHeap(event.target.value)}><option value="auto">Automatic · up to 4 GiB</option><option value="1024">1 GiB</option><option value="2048">2 GiB</option><option value="4096">4 GiB</option><option value="8192">8 GiB</option></select></label>}<label><span>Native provider</span><select aria-label="Native provider" value={provider} onChange={event => setProvider(event.target.value)} disabled={!status.connected || pending}>{providerValues.map(value => <option key={value} value={value}>{value === 'auto' ? 'Auto detect' : value}</option>)}</select></label></div>
        <div className="rea-explorer-section"><div className="rea-section-heading"><h3>PROCEDURES</h3><span>{symbols.length}</span><button aria-label="Refresh procedure list" title="Refresh procedures" onClick={() => operation('functions')} disabled={!targetReady || !toolFor(tools, 'functions')}>↻</button></div><div className="rea-search"><Icon name="search"/><input aria-label="Filter procedures" placeholder="Filter name or address…" value={symbolQuery} onChange={event => setSymbolQuery(event.target.value)}/></div>
          <div className="rea-symbol-list">{filteredSymbols.length ? filteredSymbols.map(symbol => <button key={symbol.key} className={selectedSymbol?.key === symbol.key ? 'selected' : ''} onClick={() => selectSymbol(symbol)} disabled={!usable}><span className="rea-symbol-glyph">ƒ</span><span><strong>{symbol.name}</strong><small>{symbol.address || 'Address not returned'}</small></span><span className="rea-symbol-arrow">›</span></button>) : <p className="rea-list-empty">{symbols.length ? 'No matching procedures.' : 'Open a binary to load its procedure list.'}</p>}</div>
        </div>
        <div className="rea-explorer-section rea-module-section"><div className="rea-section-heading"><h3>SCRIPTS & MODULES</h3><span title={`${moduleRows.length} distinct graph nodes`}>{new Set(moduleRows.map(module => module.path)).size} files</span></div><div className="rea-module-list">{moduleRows.length ? moduleGroups.map(folder => <div className="rea-module-folder" key={folder.folder}>{folder.folder !== '.' && <div className="rea-folder-path"><Icon name="folder"/><span>{folder.folder}</span></div>}{folder.paths.map(file => <details className="rea-module-group" key={file.path} open><summary><Icon name="file"/><span title={file.path}>{file.name}</span><small>{file.nodes.length} roles</small></summary>{file.nodes.map(module => <button key={module.key} className={selectedModule === module.node_id ? 'selected' : ''} disabled={!module.node_id || !moduleEvidence || !usable} onClick={() => inspectModule(module)} title={`${module.path}
${module.node_id || 'No node identity returned'}`}><span className="rea-node-role">{module.role.replace(/[-_]/g, ' ')}</span>{file.nodes.filter(other => other.role === module.role).length > 1 && <small>{module.node_id?.slice(-8)}</small>}</button>)}</details>)}</div>) : <p className="rea-list-empty">Application structure appears after a supported inspection.</p>}{moduleNextOffset !== undefined && <button onClick={() => loadModules(moduleEvidence, moduleNextOffset)} disabled={!usable}>Load more modules</button>}</div></div>
        <div className="rea-local-label"><Icon name="shield"/><span>Local engine · explicit tool execution</span></div>
      </aside>
      <main className="rea-analysis-panel">
        {section === 'Results' ? <ResultsPanel bridge={bridge} target={target} busy={pending}/> : <>
        <div className="rea-analysis-heading"><div><span className="rea-eyebrow">ANALYSIS WORKSPACE</span><h1>{target?.name || 'Start with a local target'}</h1><p>{profileDescriptions[profile]}</p></div><div className="rea-dossier-actions"><button onClick={previewDossier} disabled={!usable || !records.some(record => !record.result.isError)} title="Preview a dossier from actual engine records"><Icon name="file"/>Dossier</button><button className="rea-icon-button" aria-label="Save Markdown dossier" title="Save Markdown dossier" onClick={exportDossier} disabled={!dossier || !usable}><Icon name="download"/></button><button className="rea-pdf-button" aria-label="Export PDF" title="Export PDF" onClick={exportPdf} disabled={!dossier || !usable || !(bridge as any)?.exportPdf}>PDF</button></div></div>
        <div className="rea-profile-bar"><div className="rea-profile-tabs" role="tablist" aria-label="Target analysis profile">{profiles.map(item => <button key={item} role="tab" aria-selected={profile === item} className={profile === item ? 'active' : ''} onClick={() => setProfile(item)}>{item === 'JavaScript' ? 'JS / Electron' : item}</button>)}</div><button className="rea-primary" onClick={openTarget} disabled={!canInspect} title={analysisTool?.reason || (!analysisTool ? `${profileTitles[profile]} inspection is not advertised by the engine` : '')}><Icon name="arrow"/>{profile === 'Native' || profile === 'Go' ? 'Open binary' : 'Inspect target'}</button></div>
        {status.connected && (!analysisTool || analysisTool.available === false) && <p className="rea-availability">{analysisTool?.reason || `This engine does not advertise a ${profileTitles[profile].toLowerCase()} inspection tool. Browse the complete MCP inventory for available operations.`}</p>}
        <div className="rea-editor-topline"><div className="rea-editor-tabs" role="tablist" aria-label="Analysis result views">{['Pseudocode', 'Assembly', 'Source', 'Raw result'].map(tab => <button key={tab} role="tab" aria-selected={view === tab} className={view === tab ? 'active' : ''} onClick={() => { setView(tab); if (tab === 'Source' && selectedScript && current?.name !== 'readArtifact') void readSelectedSource(); if (tab === 'Assembly' && selectedSymbol && usable && !codeFrom(current?.result, 'Assembly')) operation('assembly'); }}>{tab}</button>)}</div><span className="rea-result-format">{current?.name === 'readArtifact' ? 'LOCAL SOURCE' : current ? 'ENGINE RESULT' : 'NO RESULT'}</span></div>
        <div className="rea-document-path"><Icon name="code"/><span>{recordLabel}</span>{recordAddress && recordLabel !== String(recordAddress) && <code>{String(recordAddress)}</code>}{current && <span className="rea-record-tag">#{current.id}</span>}</div>
        <>{analysisNotice && <p className="rea-analysis-notice" role="status"><strong>Partial analysis</strong>{analysisNotice.statistics && <span> · {analysisNotice.statistics}</span>}<span>{analysisNotice.reason || 'Coverage is partial; unresolved behavior remains unknown.'}</span></p>}</><div className="rea-editor-body" role="region" aria-label="Analysis result" tabIndex={0}>{view === 'Raw result' && current ? <pre className="rea-code rea-raw">{JSON.stringify(current.result, null, 2)}</pre> : code ? <>{codePreview.truncated && <p className="rea-preview-limit" role="status">Preview truncated to keep the editor responsive. Complete source and engine results remain in portable records.</p>}<div className="rea-code-lines">{codePreview.lines.map((line, index) => <div key={index}><span className="rea-line-number" aria-hidden="true">{index + 1}</span><code>{highlightedLine(line.text).map((token, tokenIndex) => <span key={tokenIndex} className={token.kind ? `rea-token-${token.kind}` : undefined}>{token.text}</span>)}</code>{line.truncated && <span className="rea-line-truncated">… line preview truncated</span>}</div>)}</div></> : view === 'Source' && selectedScript ? <div className="rea-selected-source-empty"><Empty title={busy === 'Reading selected source' ? 'Reading selected source' : 'Selected script source'} detail="Read only this selected script or its analyzed snapshot. Application module discovery is not required for a static source preview."/><button onClick={readSelectedSource} disabled={!bridge || pending}>Read selected source</button></div> : current ? <Empty title={`No ${view.toLowerCase()} returned`} detail="The engine returned a result, but it does not contain this code representation. Open Raw result to inspect the complete response."/> : <Empty title="Your investigation starts here" detail="Choose a local target, connect the REA engine, then open or inspect it. Select a procedure to request real decompiled code." icon="code"/>}</div>
        {records.length > 0 && <div className="rea-record-picker"><label htmlFor="rea-result-record">Result record</label><select id="rea-result-record" value={currentId || ''} onChange={event => { const record = records.find(item => item.id === event.target.value); setCurrentId(event.target.value); if (record) setView(record.name === 'readArtifact' || codeFrom(record.result, 'Source') ? 'Source' : codeFrom(record.result, 'Pseudocode') ? 'Pseudocode' : codeFrom(record.result, 'Assembly') ? 'Assembly' : 'Raw result'); }}>{records.map(record => <option key={record.id} value={record.id}>#{record.id} · {record.name} · {timeLabel(record.at)}</option>)}</select><span>{current?.result.isError ? 'Returned error' : 'Observed output'}</span></div>}
        <div className="rea-console-heading"><h2><span className="rea-console-square">›_</span>ENGINE OUTPUT</h2><div>{pending && <><span className="rea-spinner"/><span>{busy || 'Engine busy'}</span><button onClick={async () => { if (!bridge) return; try { await bridge.cancel(); pushEvent('Cancellation requested'); } catch (issue) { setError(String(issue)); } }}>Cancel</button></>}<span className="rea-console-count" title="Latest 1,000 session events; engine retains evidence files">{events.length}{events.length >= 1000 ? '+' : ''} events</span></div></div>
        <OutputConsole events={events}/>
        </>}
      </main>
      {section === 'Analysis' && <aside className="rea-inspector-panel" aria-label="Evidence and tools">
        <div className="rea-rail-tabs" role="tablist" aria-label="Inspector panels">{['Evidence', 'Xrefs / Strings', 'MCP / Tools'].map(item => <button key={item} role="tab" aria-selected={rail === item} className={rail === item ? 'active' : ''} onClick={() => setRail(item)}>{item}</button>)}</div>
        <div className="rea-rail-content">{rail === 'Evidence' ? <>
          <div className="rea-evidence-title"><Icon name="shield"/><div><h2>Evidence ledger</h2><p>Trace every claim to its source.</p></div></div>
          <div className="rea-provenance-legend"><span><i className="observed"/>Observed</span><span><i className="inferred"/>Inferred</span><span><i className="unknown"/>Unknown</span></div>
          <section className="rea-evidence-block"><div className="rea-evidence-block-heading"><span className="rea-provenance observed">OBSERVED</span><span>{records.length} records</span></div>{records.length ? <div className="rea-evidence-list">{records.slice().reverse().map(record => <button className={currentId === record.id ? 'selected' : ''} key={record.id} onClick={() => { setCurrentId(record.id); setView('Raw result'); }}><span className="rea-record-id">#{record.id}</span><span><strong>{record.name}</strong><small>{timeLabel(record.at)} · {record.result.isError ? 'Engine error' : record.name === 'readArtifact' ? 'Local source read' : 'Returned response'}</small></span><span>↗</span></button>)}</div> : <p className="rea-evidence-empty">No tool results yet. Completed requests appear here with their complete response.</p>}</section>
          {records.length >= 200 && <p className="rea-retention">Showing the latest 200 session records. Engine evidence and local source bytes are retained in portable records; analyst notes are session only.</p>}<section className="rea-evidence-block"><div className="rea-evidence-block-heading"><span className="rea-provenance inferred">INFERRED</span><span>Analyst notes</span></div>{inferences.map((inference, index) => <div className="rea-inference" key={index}><p>{inference.text}</p><button disabled={!inference.sourceId} onClick={() => { setCurrentId(inference.sourceId); setView('Raw result'); }}>{inference.sourceId ? `Source record #${inference.sourceId}` : 'No source selected'}</button></div>)}<label className="rea-note-label"><span>Add a session interpretation</span><textarea rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="Your interpretation of the selected result…"/></label><button className="rea-note-save" disabled={!note.trim() || !current} onClick={() => { setInferences(previous => [...previous, { text: note.trim(), sourceId: currentId, at: new Date().toISOString() }]); setNote(''); }}>Attach to record{currentId ? ` #${currentId}` : ''}</button></section>
          <section className="rea-evidence-block"><div className="rea-evidence-block-heading"><span className="rea-provenance unknown">UNKNOWN</span><span>Current limits</span></div><ul className="rea-limits">{!status.connected && <li>Engine capabilities have not been verified.</li>}{!target && <li>No local target has been selected.</li>}{residualUnknowns.slice(0, 4).map((unknown, index) => <li key={index}>{unknown}</li>)}{status.connected && target && !residualUnknowns.length && <li>Returned data covers only executed tools. Unexamined behavior remains unknown.</li>}</ul>{unknownReasons.length > 0 && <details className="rea-profile-limits"><summary>{profileTitles[profile]} capabilities: {unknownReasons.length} availability reasons</summary><ul className="rea-limits">{unknownReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>}{residualUnknowns.length > 4 && <details className="rea-profile-limits"><summary>All {residualUnknowns.length} result limitations</summary><ul className="rea-limits">{residualUnknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul></details>}<button className="rea-diagnostics-link" onClick={() => { setSelectedToolName(''); setToolQuery(''); setRail('MCP / Tools'); }}>All capability diagnostics ({unavailable.length}) ↗</button></section>
        </> : rail === 'Xrefs / Strings' ? <>
          <div className="rea-evidence-title"><Icon name="search"/><div><h2>Follow the references</h2><p>Search real engine results.</p></div></div><div className="rea-lookup-tabs" role="group" aria-label="Lookup kind"><button className={lookupKind === 'strings' ? 'active' : ''} onClick={() => { setLookupKind('strings'); setLookupResult(undefined); }}>Strings</button><button className={lookupKind === 'xrefs' ? 'active' : ''} onClick={() => { setLookupKind('xrefs'); setLookupResult(undefined); }}>Cross references</button></div>
          {lookupKind === 'strings' ? <form className="rea-lookup-search" onSubmit={event => { event.preventDefault(); operation('strings', undefined, stringsQuery); }}><input aria-label="String search query" value={stringsQuery} onChange={event => setStringsQuery(event.target.value)} placeholder="Text or pattern…"/><button type="submit" className="rea-primary" disabled={!targetReady || !stringsQuery.trim() || !toolFor(tools, 'strings')}><Icon name="search"/></button></form> : <div className="rea-xref-current"><code>{selectedSymbol?.address || selectedSymbol?.name || 'Select a procedure'}</code><button disabled={!targetReady || !selectedSymbol || !toolFor(tools, 'xrefs')} onClick={() => operation('xrefs')}>Find references</button></div>}
          {lookupResult ? lookupEntries.length ? <div className="rea-lookup-results"><span className="rea-eyebrow">{lookupEntries.length} RETURNED ENTRIES</span>{lookupEntries.map((entry, index) => { const value = typeof entry === 'object' ? entry : { text: entry }; const address = value.address ?? value.addr ?? value.from ?? value.source; const matchedSymbol = symbols.find(symbol => symbol.address && symbol.address === String(address)); const reference = address !== undefined ? matchedSymbol ?? { key: String(address), name: String(value.function_name ?? value.name ?? `Reference ${address}`), address: String(address), raw: value } : undefined; return <button key={index} disabled={!reference || !usable || (lookupKind === 'strings' && !toolFor(tools, 'xrefs'))} onClick={() => reference && (lookupKind === 'strings' ? operation('xrefs', reference) : selectSymbol(reference))}><code>{address === undefined ? `#${index + 1}` : String(address)}</code><span>{String(value.text ?? value.string ?? value.value ?? value.name ?? value.to ?? JSON.stringify(entry))}</span>{reference && <span className="rea-muted">{lookupKind === 'strings' ? 'Find references' : 'Open procedure'} ↗</span>}</button>; })}</div> : <pre className="rea-lookup-raw" role="region" aria-label="Reference result" tabIndex={0}>{readable(lookupResult)}</pre> : <Empty title={lookupKind === 'strings' ? 'Find strings in your target' : 'Trace a procedure'} detail={lookupKind === 'strings' ? 'Enter text to call the advertised string search tool.' : 'Select a procedure, then request its actual cross references.'} icon="search"/>}
        </> : <>
          <div className="rea-evidence-title"><Icon name="tools"/><div><h2>Complete tool inventory</h2><p>{tools.length ? `${readiness.advertised} advertised · ${readiness.ready} available for this session.` : 'Connect the engine to discover capabilities.'}</p></div></div>{tools.length > 0 && <p className="rea-readiness-summary">{readiness.missingProvider > 0 && `Missing provider: ${readiness.missingProvider}. `}{readiness.targetRequired > 0 && `Open target required: ${readiness.targetRequired}. `}{readiness.unsupportedHost > 0 && `Unsupported host: ${readiness.unsupportedHost}. `}{readiness.clientRequired > 0 && `Client prerequisites: ${readiness.clientRequired}. `}{readiness.unknown > 0 && `Availability unreported: ${readiness.unknown}. `}Every advertised tool remains in this catalog; unavailable entries include their actual reason.</p>}<div className="rea-search"><Icon name="search"/><input aria-label="Search MCP tools" value={toolQuery} onChange={event => setToolQuery(event.target.value)} placeholder="Search tools or capabilities…"/></div>
          {tools.length ? <><select className="rea-tool-select" aria-label="Select MCP tool" value={selectedToolName} onChange={event => { setSelectedToolName(event.target.value); setSeedOverride(undefined); }}><option value="">Select a tool ({filteredTools.length})</option>{filteredTools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}{tool.available === false ? ' · unavailable' : ''}</option>)}</select>{selectedTool ? <ToolForm onChooseInput={bridge?.chooseToolInput ? (key, kind) => bridge.chooseToolInput!({name: selectedTool.name, key, kind}) : undefined} tool={selectedTool} seed={toolSeed} disabled={!usable} onRun={runTool}/> : <div className="rea-tool-inventory">{filteredTools.map(tool => <button key={tool.name} onClick={() => showTool(tool)}><span><code>{tool.name}</code><small>{tool.description || 'No description provided'}</small></span><span className={tool.available === false ? 'rea-unavailable-indicator' : tool.available === true ? 'rea-available-indicator' : 'rea-muted'} title={tool.reason || (tool.available === false ? 'Unavailable' : tool.available === true ? 'Available in this session' : 'Availability not reported by engine')}>{tool.available === false ? '×' : tool.available === true ? '↗' : '?'}</span></button>)}{!filteredTools.length && <p className="rea-list-empty">No tools match this search.</p>}</div>}</> : <Empty title="No tool inventory yet" detail="The workspace uses tool names and argument schemas reported by your REA engine. Connect it to populate this panel." icon="tools"/>}
          <details className="rea-global-limits"><summary>All unavailable capabilities ({unavailable.length})</summary><ul className="rea-limits">{unavailable.map(tool => <li key={tool.name}><code>{tool.name}</code>: {tool.reason || 'Unavailable'}</li>)}</ul></details><button className="rea-config-button" onClick={() => inspectSystem('mcpConfig')} disabled={!bridge || pending}><Icon name="connect"/>View MCP configuration</button>
        </>}</div>
      </aside>}
    </div>
    <footer className="rea-statusbar"><div><span className={`rea-status-dot${status.connected ? ' connected' : ''}`}/><span>{status.connected ? `REA ${status.version || 'engine'}` : 'REA disconnected'}</span><span className="rea-statusbar-divider"/><span>{profileTitles[profile]}</span></div><div><span>{target ? 'Local target selected' : 'No target'}</span><span className="rea-statusbar-divider"/><span>{pending ? 'Request in progress' : 'Ready'}</span></div></footer>
    {dialog && <div className="rea-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget) setDialog(undefined); }}><section ref={dialogRef} className="rea-dialog" role="dialog" aria-modal="true" aria-labelledby="rea-dialog-title" onKeyDown={event => { if (event.key === 'Escape') setDialog(undefined); }}><div className="rea-dialog-heading"><h2 id="rea-dialog-title">{dialog.title}</h2><div>{dialog.copyText && <button disabled={!bridge?.copyText || pending} onClick={async () => { try { await bridge?.copyText?.(dialog.copyText!); setCopiedConfig(true); } catch (issue) { setError(issue instanceof Error ? issue.message : String(issue)); } }}>{copiedConfig ? 'Copied' : 'Copy configuration'}</button>}{dialog.dossier && <><button onClick={exportDossier} disabled={pending}><Icon name="download"/>Markdown</button><button onClick={exportPdf} disabled={pending || !(bridge as any)?.exportPdf}>PDF</button></>}<button autoFocus className="rea-icon-button" aria-label="Close dialog" onClick={() => setDialog(undefined)}><Icon name="close"/></button></div></div>{dialog.settings ? <div className="rea-settings-content"><p className="rea-settings-intro">Choose locally installed analysis tools. Saved paths configure REA; System health verifies whether each provider can run.</p>{settingsNotice && <p className="rea-settings-notice" role="status">{settingsNotice}</p>}<div className="rea-provider-list">{dialog.settings.map(setting => <section className="rea-provider-setting" key={setting.id}><div className="rea-provider-heading"><h3>{setting.label}</h3><span>{setting.overridden ? 'Saved override' : setting.path ? 'Environment path' : 'Default discovery'}</span></div><p>{setting.description}</p><code>{setting.path || 'No saved override. REA uses environment and default discovery.'}</code><div className="rea-provider-actions"><button onClick={() => updateSetting(setting.id, 'choose')} disabled={pending}><Icon name={setting.kind === 'directory' ? 'folder' : 'file'}/>Choose {setting.kind === 'directory' ? 'folder' : 'executable'}</button><button onClick={() => updateSetting(setting.id, 'clear')} disabled={pending || !setting.overridden}>Clear override</button></div><small>{setting.environmentKey}</small></section>)}</div><div className="rea-settings-footer"><button onClick={async () => { await connect(); setDialog(undefined); }} className="rea-primary" disabled={pending}><Icon name="connect"/>Reconnect engine</button><button onClick={() => inspectSystem('doctor')} disabled={pending}><Icon name="activity"/>Check system health</button></div></div> : dialog.health ? <><div className="rea-health-grid" role="region" aria-label="System health diagnostics" tabIndex={0}>{healthRows(dialog.health, status).map(row => <div className="rea-health-item" key={row.name}><h3>{row.name}</h3><small className="rea-health-category">{{connection:'Live connection',environment:'Host environment',provider:'Analysis provider',registration:'External client registration',audit:'Prerequisite audit'}[row.category]}</small><span className={row.status === 'available' ? 'good' : row.status === 'unavailable' ? 'bad' : ''}>{row.stateLabel || (row.status === 'available' ? 'Available' : row.status === 'unavailable' ? 'Unavailable' : 'Unknown')}</span><p>{row.detail}</p></div>)}</div><details className="rea-health-raw"><summary>Complete doctor result</summary><pre>{dialog.text}</pre></details></> : dialog.dossier ? <MarkdownViewer markdown={dialog.text}/> : <pre className="rea-dialog-content" role="region" aria-label="Complete result" tabIndex={0}>{dialog.text}</pre>}</section></div>}
  </div>;
}
export default Workspace;
