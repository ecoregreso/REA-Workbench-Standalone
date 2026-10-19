import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as nodeFilesystem from 'node:fs/promises';
import { constants as filesystemFlags } from 'node:fs';
import { freemem } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { EngineEvent, EngineStatus, ProviderSetting, ProviderSettingId, ReaResult, Target } from './types.js';
import { ResultsLibrary } from './resultsLibrary';
export { ResultsLibrary, describeResult } from './resultsLibrary';

export const automaticJavaScriptHeapMb = (availableBytes: number): number => Math.max(128, Math.min(4096, Math.floor(availableBytes / (4 * 1024 * 1024 * 128)) * 128));

export type ReaEngineOptions = {
  entryPath: string;
  runtimePath?: string;
  environment?: Record<string, string | undefined>;
  dataDir: string;
  eventSink?: (event: EngineEvent) => void;
  requestTimeoutMs?: number;
  filesystem?: EngineFilesystem;
  runtimeBootstrapPath?: string;
};
export type EngineFilesystem = Pick<typeof nodeFilesystem, 'copyFile' | 'mkdir' | 'open' | 'realpath' | 'rename' | 'stat' | 'lstat' | 'writeFile' | 'readFile' | 'readdir' | 'rm'>;

type Observation = { operation: string; timestamp: string; file: string; error: boolean; evidenceId?: string; summary?: unknown; kind?: 'rea-tool' | 'static-bytes' };
const MAX_LOG_BYTES = 16_384;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 64 * 1024 * 1024;
type SourceSnapshot = { path: string; sha256: string; bytes: number; stagedPath: string; provenancePath: string; scope: 'selected-file-only' };
const MAX_RESULT_BYTES = 12 * 1024 * 1024;
const PATH_KEY = /^(?:path|input_path|output_directory|output_root|output_path|snapshot_path|application_path|executable_path|working_directory|capture_path|source_map_path|reference_path|left_path|right_path|binary_path|core_path|manifest_path|local_path|apk_path|application_root|left_module_path|right_module_path|left_bundle_path|right_bundle_path|executable|filesystem_observation_paths|roots)$/u;
const SECRET_KEY = /(?:token|secret|password|credential|api[_-]?key|authorization)/iu;
const SECRET = /(?:\b(?:sk-(?:proj-)?|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,]+|((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,]+)/giu;
const redact = (value: string) => value.replace(SECRET, (_match, prefix, otherPrefix) => `${prefix ?? otherPrefix ?? ''}[redacted]`);
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 2048);
const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const INHERITED_ENVIRONMENT_KEYS = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'];
/** Preserve Windows Path/SystemRoot values by matching environment names without case. */
export const reaHostEnvironment = (baseline: Record<string, string | undefined>, overrides: Record<string, string | undefined> = {}, platform: NodeJS.Platform = process.platform): Record<string, string> => {
  const environment: Record<string, string> = {};
  const canonicalKey = (key: string) => platform === 'win32' ? key.toUpperCase() : key;
  for (const [name, value] of Object.entries(baseline)) {
    const key = canonicalKey(name);
    if (value !== undefined && INHERITED_ENVIRONMENT_KEYS.includes(key)) environment[key] = value;
  }
  for (const [name, value] of Object.entries(overrides)) if (value !== undefined) environment[canonicalKey(name)] = value;
  return environment;
};
type ProviderDefinition = Omit<ProviderSetting, 'path' | 'overridden'>;
const PROVIDER_SETTINGS: ReadonlyArray<ProviderDefinition> = [
  { id: 'ghidra', label: 'Ghidra installation', kind: 'directory', environmentKey: 'GHIDRA_INSTALL_DIR', description: 'Choose an extracted Ghidra 12.1.x release directory. Native analysis also requires its supported full JDK.' },
  { id: 'hopper', label: 'Hopper executable', kind: 'file', environmentKey: 'HOPPER_LAUNCHER_PATH', description: 'Choose your licensed Hopper executable. On macOS you may select its application bundle.' },
  { id: 'ida', label: 'IDA MCP registration', kind: 'file', environmentKey: 'REA_IDA_MCP_CONFIG', description: 'Choose the upstream IDA MCP registration JSON for your licensed IDA installation.' },
  { id: 'jadx', label: 'JADX headless MCP JAR', kind: 'file', environmentKey: 'REA_JADX_MCP_JAR', description: 'Choose a separately obtained jadx-headless-mcp 0.7.1 JAR. Android code inspection also requires a full JDK.' },
  { id: 'adb', label: 'Android platform tools — ADB', kind: 'file', environmentKey: 'REA_ADB_PATH', description: 'Choose adb from Android platform tools. Device operations require an authorized device and its serial.' },
  { id: 'apktool', label: 'Apktool launcher', kind: 'file', environmentKey: 'REA_APKTOOL_COMMAND', description: 'Choose an Apktool launcher with Java configured. Used for Android resource decoding.' },
  { id: 'pwntools', label: 'Pwntools Python', kind: 'file', environmentKey: 'REA_PWNTOOLS_PYTHON', description: 'Choose the Python executable in an environment with pwntools 4.15.0. REA currently supports this provider on Linux x64.' },
  { id: 'wakaru', label: 'Wakaru executable', kind: 'file', environmentKey: 'REA_WAKARU_COMMAND', description: 'Choose the native Wakaru 1.14.0 binary for static JavaScript recovery. REA currently supports Linux x64 with prlimit.' },
  { id: 'binwalk', label: 'Binwalk executable', kind: 'file', environmentKey: 'REA_BINWALK_COMMAND', description: 'Choose Binwalk 3.1.x for firmware signature inspection. Requires Linux and prlimit.' },
  { id: 'unblob', label: 'Unblob launcher', kind: 'file', environmentKey: 'REA_UNBLOB_COMMAND', description: 'Choose Unblob 26.6.x for firmware extraction. Requires Linux, prlimit, and extractors for the selected format.' },
  { id: 'browser', label: 'Chromium browser executable', kind: 'file', environmentKey: 'REA_BROWSER_EXECUTABLE', description: 'Choose a Chromium browser for JavaScript runtime resolution. Browser inspection tools also require an explicit CDP endpoint and target.' },
  { id: 'java', label: 'Java JDK home', kind: 'directory', environmentKey: 'JAVA_HOME', description: 'Choose the full JDK directory containing bin/java and bin/javac. macOS .jdk bundles are normalized to Contents/Home.' },
];
export const providerSettingDefinitions = (): ProviderDefinition[] => PROVIDER_SETTINGS.map(setting => ({ ...setting }));

/** Shared host-owned engine: renderer callers never supply executable commands. */
export class ReaEngine {
  private client?: Client;
  private transport?: StdioClientTransport;
  private state: EngineStatus = { connected: false, toolCount: 0, busy: false, tools: [] };
  private definitions = new Map<string, any>();
  private targets = new Map<string, Target>();
  private toolInputs = new Map<string, 'file' | 'directory'>();
  private listeners = new Set<(event: EngineEvent) => void>();
  private controller?: AbortController;
  private doctorChild?: ChildProcess;
  private disposed = false;
  private resetting = false;
  private resetPromise?: Promise<void>;
  private activeDone?: Promise<void>;
  private logs = '';
  private observations: Observation[] = [];
  private evidenceSnapshots = new Set<string>();
  private sourceSnapshots: SourceSnapshot[] = [];
  private providerProbes = new Map<string, { available: boolean; result: ReaResult }>();
  private opened = false;
  private openedTargetId?: string;
  private generation = 0;
  private scopeRevision = 0;
  private readonly options: ReaEngineOptions;
  private readonly filesystem: EngineFilesystem;
  private readonly results: ResultsLibrary;
  private resultsLoading?: Promise<void>;
  private readonly baselineEnvironment: Record<string, string | undefined>;
  private providerOverrides = new Map<ProviderSettingId, string>();
  private settingsLoaded = false;
  private settingsLoading?: Promise<void>;

  constructor(options: ReaEngineOptions) {
    if (!isAbsolute(options.entryPath) || !isAbsolute(options.dataDir) || (options.runtimeBootstrapPath !== undefined && !isAbsolute(options.runtimeBootstrapPath))) throw new Error('REA entry, bootstrap and data directory must be absolute paths.');
    this.options = { ...options, entryPath: resolve(options.entryPath), dataDir: resolve(options.dataDir), environment: { ...options.environment } };
    this.filesystem = options.filesystem ?? nodeFilesystem;
    this.results = new ResultsLibrary(this.options.dataDir, this.filesystem);
    this.baselineEnvironment = reaHostEnvironment(process.env, options.environment);
    if (options.eventSink) this.listeners.add(options.eventSink);
  }

  onEvent(callback: (event: EngineEvent) => void) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  async status(): Promise<EngineStatus> { return this.snapshot(); }
  async listResults() { if (this.disposed) throw new Error('REA engine has been disposed.'); await this.loadPreviousResults(); return this.results.list(); }
  async readResult(id: string) { if (this.disposed || typeof id !== 'string') throw new Error('Choose a saved result.'); return this.results.read(id); }
  async importResults(path: string) {
    return this.exclusive('Importing recovered files', async () => {
      const target = this.state.target;
      if (!target) throw new Error('Select the original target before importing recovered files.');
      if (!isAbsolute(path)) throw new Error('Choose a local recovered output folder.');
      const canonical = await this.filesystem.realpath(path);
      if (!(await this.filesystem.lstat(canonical)).isDirectory()) throw new Error('Choose a recovered output folder.');
      const result = await this.results.capture({ target, operation: 'import_recovered_files', arguments: {}, result: {} }, [canonical]);
      this.emit({ type: 'progress', text: `${result.saved} files saved to Results`, phase: 'results', warnings: result.warnings });
      return result;
    });
  }
  async exportResults(input: { targetPath?: string } = {}) {
    return this.exclusive('Exporting saved Results', async () => {
      await this.loadPreviousResults();
      const path = join(this.options.dataDir, 'results-exports', `${Date.now()}-${randomUUID().slice(0, 8)}`);
      const targetPath = input.targetPath === undefined ? undefined : await this.filesystem.realpath(input.targetPath).catch(() => resolve(input.targetPath!));
      const count = await this.results.exportTo(path, targetPath);
      return { path, count };
    });
  }
  private async loadPreviousResults(): Promise<void> {
    if (this.resultsLoading) return this.resultsLoading;
    this.resultsLoading = (async () => {
      const marker = join(this.options.dataDir, 'results', 'imported-records.json');
      let imported: Record<string, string> = {};
      try { imported = JSON.parse(await this.filesystem.readFile(marker, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      let sessions;
      try { sessions = await this.filesystem.readdir(join(this.options.dataDir, 'records'), { withFileTypes: true }); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        for (const file of await this.filesystem.readdir(join(this.options.dataDir, 'records', session.name), { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith('.json') || file.name.startsWith('evidence-session-')) continue;
          const path = join(this.options.dataDir, 'records', session.name, file.name);
          const info = await this.filesystem.stat(path); const revision = `${info.size}:${info.mtimeMs}`;
          if (imported[path] === revision || info.size > MAX_RESULT_BYTES) continue;
          try {
            const record = JSON.parse(await this.filesystem.readFile(path, 'utf8'));
            if (!record.result || record.result.isError || /^(read_artifact|export_evidence_bundle|get_evidence_bundle|binary_session)$/.test(record.operation)) { imported[path] = revision; continue; }
            const payload = this.payload(record.result);
            const targetPath = record.target?.path ?? record.result.meta?.source?.path ?? payload?.subject?.local_path ?? record.arguments?.path;
            if (typeof targetPath !== 'string' || !isAbsolute(targetPath)) continue;
            const target: Target = record.target ?? { id: session.name, path: targetPath, name: basename(targetPath), kind: 'file' };
            const saved = await this.results.capture({ target, operation: record.operation, arguments: record.arguments ?? {}, result: { ...record.result, structuredContent: payload }, evidenceId: payload?.evidence_id ?? payload?.normalized_result?.parent_evidence_id });
            if (!saved.warnings.length) imported[path] = revision;
            else { this.log(`Earlier Results need attention: ${saved.warnings.join('; ')}`, 'results'); this.emit({ type: 'progress', phase: 'results', text: 'Earlier Results need attention', warnings: saved.warnings }); }
          } catch (error) { this.log(`Earlier result import failed: ${errorText(error)}`, 'results'); }
        }
      }
      await this.filesystem.mkdir(dirname(marker), { recursive: true, mode: 0o700 });
      await this.atomicWrite(marker, JSON.stringify(imported, null, 2));
    })().catch(error => { this.resultsLoading = undefined; throw error; });
    return this.resultsLoading;
  }

  async connect(): Promise<EngineStatus> {
    await this.exclusive('Connecting to REA', async (signal) => { await this.connectInternal(signal); });
    return this.snapshot();
  }

  async selectTarget(path: string, kind: 'file' | 'directory' | 'auto' = 'auto'): Promise<Target> {
    return this.exclusive('Selecting target', async () => {
      if (!isAbsolute(path)) throw new Error('Select an absolute target path.');
      const canonical = await this.filesystem.realpath(path);
      const info = await this.filesystem.stat(canonical);
      const applicationBundle = info.isDirectory() && /\.app$/iu.test(canonical);
      if (kind === 'auto' ? !info.isFile() && !info.isDirectory() : kind === 'file' ? !info.isFile() && !applicationBundle : !info.isDirectory()) throw new Error(`Selected target is not a ${kind}.`);
      if (this.state.target?.path === canonical) return { ...this.state.target };
      // A fresh ledger prevents another project's retained evidence entering this dossier.
      await this.disconnectInternal();
      ++this.scopeRevision;
      const target: Target = { id: randomUUID(), path: canonical, name: basename(canonical), kind: info.isDirectory() ? 'directory' : 'file', ...(info.isFile() ? { size: info.size } : {}) };
      this.targets.clear(); this.toolInputs.clear(); this.targets.set(target.id, target);
      this.state.target = target; this.state.tools = []; this.state.toolCount = 0; this.definitions.clear();
      this.observations = []; this.evidenceSnapshots.clear(); this.sourceSnapshots = []; this.opened = false; this.openedTargetId = undefined;
      this.emit({ type: 'status', text: `Selected ${target.name}` });
      return { ...target };
    });
  }

  async openTarget(input: { targetId: string; providerId?: string; maxHeapMb?: number }): Promise<ReaResult> {
    return this.exclusive('Opening target', async (signal) => {
      const target = this.targets.get(input.targetId);
      if (!target || target.id !== this.state.target?.id) throw new Error('Choose the target through the host file dialog first.');
      await this.connectInternal(signal);
      const requestedProvider = input.providerId ?? 'auto';
      const provider = requestedProvider === 'auto' && this.childEnvironment().REA_ANALYSIS_PROVIDER === 'ghidra' ? 'ghidra' : requestedProvider;
      if (!['auto', 'hopper', 'ghidra', 'ida'].includes(provider)) throw new Error('Unsupported native provider.');
      const availableBytes = Math.min(freemem(), typeof process.availableMemory === 'function' ? process.availableMemory() : freemem());
      const maxHeapMb = input.maxHeapMb ?? automaticJavaScriptHeapMb(availableBytes);
      if (!Number.isInteger(maxHeapMb) || maxHeapMb < 128 || maxHeapMb > 16384) throw new Error('JavaScript analysis memory must be between 128 and 16384 MiB.');
      let name: string; let args: Record<string, any>; let meta: Record<string, any> | undefined;
      if (/\.app$/iu.test(target.path) && target.kind === 'directory') {
        name = 'open_binary'; args = { path: target.path, provider_id: provider };
      } else if (target.kind === 'file' && /\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx)$/iu.test(target.path)) {
        const source = await this.stageSelectedScript(target, signal);
        name = 'analyze_javascript_application';
        args = { input_path: dirname(source.stagedPath), format: 'directory', detail: 'summary', max_heap_mb: maxHeapMb };
        meta = { sourceRoot: dirname(source.stagedPath), analysisInputPath: dirname(source.stagedPath), source };
      } else if (target.kind === 'directory' || /\.asar$/iu.test(target.path)) {
        name = 'analyze_javascript_application';
        args = { input_path: target.path, format: target.kind === 'directory' ? 'directory' : 'asar', detail: 'summary', max_heap_mb: maxHeapMb };
      } else if (/\.apk$/iu.test(target.path)) {
        name = 'inspect_android_package'; args = { path: target.path };
      } else if (/\.(?:zip|ipa|msix|appx|dmg|plist|nib|storyboardc)$/iu.test(target.path)) {
        name = 'open_binary'; args = { path: target.path };
      } else {
        // Native PE and CLR both use open_binary's header classifier. A .dll filename alone is not CLR proof.
        name = 'open_binary'; args = { path: target.path, provider_id: provider };
      }
      const result = await this.invoke(name, args, signal, true, meta);
      this.opened = !result.isError; this.openedTargetId = this.opened ? target.id : undefined;
      await this.refreshAvailability(signal);
      return result;
    });
  }

  /** Adapt one selected script to REA's directory contract without reading its siblings. */
  private async stageSelectedScript(target: Target, signal: AbortSignal): Promise<SourceSnapshot> {
    const handle = await this.filesystem.open(target.path, filesystemFlags.O_RDONLY | filesystemFlags.O_NOFOLLOW | filesystemFlags.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_SCRIPT_BYTES) throw new Error('Select a regular JavaScript/TypeScript file no larger than 64 MiB.');
      bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        if (signal.aborted) throw signal.reason;
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error('Selected script changed while being read.');
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      const current = await this.filesystem.stat(target.path);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev) throw new Error('Selected script changed while being read.');
      if (bytes.includes(0)) throw new Error('Selected script contains binary bytes.');
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally { await handle.close(); }
    if (signal.aborted) throw signal.reason;
    const root = join(this.options.dataDir, 'inputs', target.id, randomUUID());
    await this.filesystem.mkdir(root, { recursive: true, mode: 0o700 });
    const canonicalRoot = await this.filesystem.realpath(root);
    const stagedPath = join(canonicalRoot, basename(target.path));
    const provenancePath = join(canonicalRoot, 'workbench-source-provenance.json');
    const source: SourceSnapshot = { path: target.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, stagedPath, provenancePath, scope: 'selected-file-only' };
    await this.filesystem.writeFile(stagedPath, bytes, { flag: 'wx', mode: 0o600 });
    // A synthetic entry only supplies REA's application-input shape. Imports outside this
    // folder remain unresolved, and the selected script is never executed.
    await this.filesystem.writeFile(join(root, 'package.json'), JSON.stringify({ name: 'rea-selected-script', private: true, main: basename(stagedPath), ...( /\.(?:mjs|ts)$/iu.test(stagedPath) ? { type: 'module' } : {}) }), { flag: 'wx', mode: 0o600 });
    await this.filesystem.writeFile(provenancePath, JSON.stringify({ authority: 'workbench-static-bytes', ...source, syntheticEntry: true, limitations: ['Only the selected file was copied.', 'Sibling files and outside imports were not acquired.', 'Static analysis does not establish runtime behavior.'] }, null, 2), { flag: 'wx', mode: 0o600 });
    this.sourceSnapshots.push(source);
    return source;
  }

  async callTool(input: { name: string; arguments: Record<string, any> }): Promise<ReaResult> {
    return this.exclusive(input.name, async (signal) => {
      if (typeof input.name !== 'string' || !isRecord(input.arguments)) throw new Error('A tool name and JSON argument object are required.');
      if (Buffer.byteLength(JSON.stringify(input.arguments)) > MAX_INPUT_BYTES) throw new Error('Tool input exceeds the 2 MiB limit.');
      await this.connectInternal(signal);
      await this.validatePaths(input.arguments, '', input.name);
      if (input.name === 'open_binary' && !this.state.target) throw new Error('Choose the target through the file dialog first.');
      let args = input.arguments; let meta: Record<string, any> | undefined;
      const target = this.state.target;
      if (input.name === 'analyze_javascript_application' && target?.kind === 'file' && args.input_path === target.path && /\.(?:js|mjs|cjs|ts|mts|cts|jsx|tsx)$/iu.test(target.path)) {
        const source = await this.stageSelectedScript(target, signal);
        args = { ...args, input_path: dirname(source.stagedPath), format: 'directory', detail: args.detail ?? 'summary', max_heap_mb: args.max_heap_mb ?? automaticJavaScriptHeapMb(Math.min(freemem(), typeof process.availableMemory === 'function' ? process.availableMemory() : freemem())) };
        meta = { sourceRoot: dirname(source.stagedPath), analysisInputPath: dirname(source.stagedPath), source };
      }
      const result = await this.invoke(input.name, args, signal, true, meta);
      if (input.name === 'open_binary' && !result.isError) { this.opened = true; this.openedTargetId = this.state.target?.id; }
      if (input.name === 'close_binary' && !result.isError) { this.opened = false; this.openedTargetId = undefined; }
      if (input.name === 'open_binary' || input.name === 'close_binary' || input.name === 'inspect_managed_artifact') await this.refreshAvailability(signal);
      return result;
    });
  }

  async authorizeToolInput(name: string, key: string, path: string, kind: 'file' | 'directory'): Promise<string> {
    return this.exclusive('Selecting tool input', async (signal) => {
      await this.connectInternal(signal);
      const schema = this.definitions.get(name)?.inputSchema;
      if (!schema?.properties?.[key] || !PATH_KEY.test(key) || key.startsWith('output_') || (key === 'path' && name === 'export_evidence_bundle') || (key === 'snapshot_path' && name === 'close_binary')) throw new Error('This field is not an advertised local input path.');
      if (!isAbsolute(path) || path.includes('\0')) throw new Error('Choose an absolute local input.');
      const canonical = await this.filesystem.realpath(path);
      const info = await this.filesystem.stat(canonical);
      if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new Error(`Choose a ${kind} for ${key}.`);
      this.toolInputs.set(canonical, kind);
      return canonical;
    });
  }

  async doctor(): Promise<any> {
    return this.exclusive('Checking REA prerequisites', async (signal) => {
      await this.loadProviderSettings();
      await this.filesystem.mkdir(this.options.dataDir, { recursive: true });
      await this.filesystem.mkdir(join(this.options.dataDir, 'tmp'), { recursive: true });
      await this.filesystem.mkdir(join(this.options.dataDir, 'engine-home'), { recursive: true, mode: 0o700 });
      // Audit-wide readiness remains distinct from successful MCP startup.
      const report = await this.runCli(['doctor', '--format', 'json'], signal);
      this.emit({ type: 'status', text: report.healthy ? 'REA prerequisite check passed' : 'Some REA prerequisites are unavailable; inspect the report.' });
      return report;
    });
  }

  async cancel(): Promise<void> {
    if (!this.state.busy) return;
    this.controller?.abort(new Error('Cancelled by the user.'));
    this.doctorChild?.kill('SIGTERM');
    // Abort notifies MCP; closing owned transport bounds even an unresponsive provider.
    await this.disconnectInternal();
    this.emit({ type: 'status', text: 'Cancelled. Reconnect to begin a fresh session; saved records remain on disk.' });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller?.abort(new Error('REA host is shutting down.'));
    this.doctorChild?.kill('SIGTERM');
    await this.disconnectInternal();
    await this.activeDone;
    this.listeners.clear();
  }

  async reset(): Promise<void> {
    if (this.resetPromise) return this.resetPromise;
    this.resetting = true;
    ++this.scopeRevision;
    this.resetPromise = (async () => {
      this.controller?.abort(new Error('REA workspace changed.'));
      this.doctorChild?.kill('SIGTERM');
      await this.disconnectInternal();
      await this.activeDone;
      this.targets.clear(); this.toolInputs.clear(); this.observations = []; this.evidenceSnapshots.clear(); this.sourceSnapshots = []; this.definitions.clear(); this.logs = '';
      this.state = { connected: false, toolCount: 0, busy: false, tools: [] };
      this.emit({ type: 'status', text: 'REA workspace cleared', connected: false });
    })().finally(() => { this.resetting = false; this.resetPromise = undefined; });
    return this.resetPromise;
  }

  async readArtifact(path: string): Promise<{ path: string; text: string }> {
    if (this.disposed) throw new Error('REA engine has been disposed.');
    if (this.resetting) throw new Error('REA workspace is resetting.');
    const scope = this.scopeRevision;
    const archived = await this.readAsarArtifact(path);
    if (archived) { this.assertPreviewScope(scope); await this.retainSourceRead(archived, scope); return archived; }
    const canonical = await this.authorizedPath(path, false);
    const handle = await this.filesystem.open(canonical, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Only regular text files can be previewed.');
      if (info.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds the 2 MiB text preview limit. Open the exported file in an external viewer.');
      const bytes = Buffer.alloc(info.size); let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error('Source file changed while it was being read.');
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('Source file changed while it was being read.');
      if (bytes.includes(0)) throw new Error('Binary artifacts cannot be shown as text.');
      this.assertPreviewScope(scope);
      const result = { path: canonical, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
      await this.retainSourceRead(result, scope);
      return result;
    } finally { await handle.close(); }
  }

  private assertPreviewScope(scope: number) {
    if (this.disposed || this.resetting || this.scopeRevision !== scope) throw new Error('REA target changed while the source was being read.');
  }

  private async retainSourceRead(result: { path: string; text: string }, scope: number) {
    const target = this.state.target;
    if (!target) return;
    const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
    // Output previews contain earlier reports or records; never journal them recursively.
    const outputRoot = await this.filesystem.realpath(this.options.dataDir).catch(() => this.options.dataDir);
    const snapshot = this.sourceSnapshots.find(source => source.stagedPath === result.path);
    if (within(outputRoot, result.path) && !snapshot) return;
    if (!snapshot && (target.kind === 'directory' ? !within(target.path, result.path) : result.path !== target.path && !(/\.asar$/iu.test(target.path) && within(target.path, result.path)))) return;
    this.assertPreviewScope(scope);
    const timestamp = new Date().toISOString();
    const source = { path: snapshot?.path ?? result.path, ...(snapshot ? { read_path: result.path, scope: snapshot.scope } : {}), sha256: createHash('sha256').update(result.text, 'utf8').digest('hex'), bytes: Buffer.byteLength(result.text, 'utf8') };
    if (snapshot && (source.sha256 !== snapshot.sha256 || source.bytes !== snapshot.bytes)) throw new Error('Selected source snapshot changed before preview.');
    const directory = join(this.options.dataDir, 'records', target.id);
    await this.filesystem.mkdir(directory, { recursive: true });
    const file = join(directory, `${Date.now()}-read_artifact-${randomUUID().slice(0, 8)}.json`);
    await this.atomicWrite(file, JSON.stringify({ operation: 'read_artifact', authority: 'workbench-static-bytes', timestamp, source, result }, null, 2));
    this.assertPreviewScope(scope);
    this.observations.push({ operation: 'read_artifact', timestamp, file, error: false, kind: 'static-bytes', summary: source });
  }

  /** Read one bounded, inert ASAR member through raw filesystem handles only.
   * Extent checks follow REA 6.4.0 artifacts/AsarHeader and Electron's Chromium-pickle layout.
   * No archive extraction, target execution, host noAsar mutation or archive-link following occurs.
   */
  private async readAsarArtifact(path: string): Promise<{ path: string; text: string } | undefined> {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) return undefined;
    const portable = process.platform === 'win32' ? path.replaceAll('\\', '/') : path;
    const matches = portable.matchAll(/\.asar\//giu);
    for (const match of matches) {
      const carrier = portable.slice(0, match.index! + '.asar'.length);
      const member = portable.slice(match.index! + '.asar/'.length);
      const segments = member.split('/');
      if (!member || member.length > 4096 || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) throw new Error('Unsafe ASAR member path.');
      const canonical = await this.authorizedPath(carrier, false);
      if (!(await this.filesystem.stat(canonical)).isFile()) continue;
      const handle = await this.filesystem.open(canonical, filesystemFlags.O_RDONLY | filesystemFlags.O_NOFOLLOW | filesystemFlags.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error('ASAR carrier is not a regular file.');
        const readExactly = async (reader: typeof handle, size: number, position: number): Promise<Buffer> => {
          const bytes = Buffer.alloc(size); let read = 0;
          while (read < size) {
            const result = await reader.read(bytes, read, size - read, position + read);
            if (!result.bytesRead) throw new Error('ASAR bytes ended before their declared extent.');
            read += result.bytesRead;
          }
          return bytes;
        };
        const prefix = await readExactly(handle, 16, 0);
        const headerBytes = prefix.readUInt32LE(4); const payloadBytes = prefix.readUInt32LE(8); const jsonBytes = prefix.readUInt32LE(12);
        if (prefix.readUInt32LE(0) !== 4 || headerBytes < 8 || headerBytes > before.size - 8 || payloadBytes !== headerBytes - 4 || jsonBytes > payloadBytes - 4) throw new Error('ASAR header has invalid pickle extents.');
        if (headerBytes > 16 * 1024 * 1024) throw new Error('ASAR header exceeds the 16 MiB decode limit.');
        const headerData = await readExactly(handle, jsonBytes, 16);
        let header: any;
        try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerData)); }
        catch { throw new Error('Malformed ASAR JSON header.'); }
        let node = header;
        for (const segment of segments) {
          if (!isRecord(node) || 'link' in node) throw new Error('ASAR symlink members cannot be previewed.');
          if (!isRecord(node.files) || !Object.prototype.hasOwnProperty.call(node.files, segment)) throw new Error('Requested member is absent from the ASAR header.');
          node = node.files[segment];
        }
        if (!isRecord(node) || 'files' in node || 'link' in node) throw new Error('Requested ASAR member is not a regular file.');
        if (!Number.isSafeInteger(node.size) || node.size < 0) throw new Error('ASAR member has an invalid declared size.');
        if (node.size > MAX_ARTIFACT_BYTES) throw new Error('ASAR member exceeds the 2 MiB text preview limit.');
        let bytes: Buffer;
        if (node.unpacked === true) {
          const companion = `${canonical}.unpacked`;
          const companionInfo = await this.filesystem.lstat(companion);
          if (!companionInfo.isDirectory() || companionInfo.isSymbolicLink()) throw new Error('ASAR unpacked companion must be a regular directory.');
          const root = await this.filesystem.realpath(companion);
          const candidate = join(companion, ...segments);
          const rawInfo = await this.filesystem.lstat(candidate);
          const source = await this.filesystem.realpath(candidate);
          const within = relative(root, source);
          if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within) || !rawInfo.isFile() || rawInfo.isSymbolicLink()) throw new Error('ASAR unpacked member escaped its companion directory or is a link.');
          const unpackedHandle = await this.filesystem.open(source, filesystemFlags.O_RDONLY | filesystemFlags.O_NOFOLLOW | filesystemFlags.O_NONBLOCK);
          try {
            const observed = await unpackedHandle.stat();
            if (!observed.isFile() || observed.size !== node.size || observed.dev !== rawInfo.dev || observed.ino !== rawInfo.ino) throw new Error('ASAR unpacked member changed or disagrees with its declared size.');
            bytes = await readExactly(unpackedHandle, node.size, 0);
            const after = await unpackedHandle.stat();
            if (observed.size !== after.size || observed.mtimeMs !== after.mtimeMs || observed.ctimeMs !== after.ctimeMs) throw new Error('ASAR unpacked member changed while being read.');
          } finally { await unpackedHandle.close(); }
        } else {
          if (typeof node.offset !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(node.offset)) throw new Error('ASAR member has an invalid byte offset.');
          const start = 8 + headerBytes + Number(node.offset);
          if (!Number.isSafeInteger(start) || start < 8 + headerBytes || start > before.size || node.size > before.size - start) throw new Error('ASAR member range leaves its container.');
          bytes = await readExactly(handle, node.size, start);
        }
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('ASAR carrier changed while being read.');
        if (node.integrity !== undefined) {
          if (!isRecord(node.integrity) || node.integrity.algorithm !== 'SHA256' || typeof node.integrity.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(node.integrity.hash) || createHash('sha256').update(bytes).digest('hex') !== node.integrity.hash) throw new Error('ASAR member failed its declared SHA-256 integrity check.');
        }
        if (bytes.includes(0)) throw new Error('Binary ASAR members cannot be shown as source text.');
        return { path: `${canonical}/${member}`, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
      } finally { await handle.close(); }
    }
    return undefined;
  }

  async exportDossier(): Promise<{ path: string; markdown: string } | null> {
    return this.exclusive('Exporting dossier', async (signal) => {
      const target = this.state.target;
      if (!target) throw new Error('Select and analyze a target before exporting a dossier.');
      const observations = this.observations.map(record => ({ ...record }));
      const snapshots = [...this.evidenceSnapshots];
      if (!observations.length) throw new Error('Run an analysis or read target source before exporting a dossier.');
      await this.connectInternal(signal);
      const output = join(this.options.dataDir, 'dossiers', `${Date.now()}-${target.name.replace(/[^A-Za-z0-9_.-]/gu, '_')}-${randomUUID().slice(0, 8)}`);
      await this.filesystem.mkdir(output, { recursive: true });
      const evidencePath = join(output, 'evidence.json');
      const evidence = await this.invoke('export_evidence_bundle', { path: evidencePath, overwrite: false }, signal, false);
      if (evidence.isError) throw new Error(this.toolError(evidence));
      const archivedBundles: string[] = [];
      for (const archived of snapshots) {
        const destination = join(output, basename(archived));
        await this.filesystem.copyFile(archived, destination);
        archivedBundles.push(basename(destination));
      }
      const journalDirectory = join(output, 'records');
      await this.filesystem.mkdir(journalDirectory);
      for (const observation of observations) await this.filesystem.copyFile(observation.file, join(journalDirectory, basename(observation.file)));
      const sources: string[] = [];
      for (const [index, source] of this.sourceSnapshots.entries()) {
        const directory = join(output, 'sources', String(index + 1));
        await this.filesystem.mkdir(directory, { recursive: true });
        const bytes = await this.filesystem.readFile(source.stagedPath);
        if (bytes.length !== source.bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Selected source snapshot changed; refusing a mismatched portable source export.');
        await this.filesystem.writeFile(join(directory, basename(source.stagedPath)), bytes, { flag: 'wx', mode: 0o600 });
        await this.filesystem.copyFile(source.provenancePath, join(directory, 'provenance.json'));
        sources.push(`sources/${index + 1}/${basename(source.stagedPath)}`, `sources/${index + 1}/provenance.json`);
      }
      const markdown = this.renderDossier(target, basename(evidencePath), archivedBundles, observations, sources);
      const resultCount = await this.results.exportTo(join(output, 'results'), target.path);
      const withResults = markdown + `\n## Saved Results\n\n${resultCount} recovered files with plain-English descriptions: [Results library](results/Results.md).\n`;
      const path = join(output, 'dossier.md');
      await this.atomicWrite(path, withResults);
      this.emit({ type: 'status', text: `Dossier exported: ${path}` });
      return { path, markdown: withResults };
    });
  }

  async mcpConfig(): Promise<{ transport: string; configuration: Record<string, any>; description: string }> {
    await this.loadProviderSettings();
    const environment = this.childEnvironment();
    const explicit = Object.fromEntries(Object.entries(environment).filter(([key]) => !SECRET_KEY.test(key) && (key.startsWith('REA_') || ['GHIDRA_INSTALL_DIR', 'JAVA_HOME', 'HOPPER_LAUNCHER_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key))));
    return {
      transport: 'stdio',
      configuration: { mcpServers: { rea: { command: this.options.runtimePath ?? process.execPath, args: this.runtimeArguments(['mcp']), env: explicit } } },
      description: 'Local REA stdio server. The absolute paths describe this installation; import them into your agent client and restart it. Provider engines use their own prerequisite settings.',
    };
  }

  async providerSettings(): Promise<ProviderSetting[]> {
    if (this.disposed) throw new Error('REA engine has been disposed.');
    await this.loadProviderSettings();
    return this.providerSettingsSnapshot();
  }

  async configureProvider(id: string, path?: string): Promise<ProviderSetting[]> {
    const definition = PROVIDER_SETTINGS.find(setting => setting.id === id);
    if (!definition) throw new Error('Unknown provider setting.');
    if (path !== undefined && typeof path !== 'string') throw new Error('Provider path must be a string.');
    return this.exclusive(`Configuring ${definition.label}`, async () => {
      await this.loadProviderSettings();
      const overrides = new Map(this.providerOverrides);
      if (path === undefined) overrides.delete(definition.id);
      else overrides.set(definition.id, await this.normalizeProviderPath(definition, path));
      await this.filesystem.mkdir(this.options.dataDir, { recursive: true });
      await this.atomicWrite(join(this.options.dataDir, 'provider-settings.json'), JSON.stringify({ version: 1, paths: Object.fromEntries(overrides) }, null, 2));
      // All completed operations were snapshotted before configuration changes.
      await this.disconnectInternal();
      this.providerOverrides = overrides; this.definitions.clear(); this.state.tools = []; this.state.toolCount = 0;
      this.emit({ type: 'status', text: 'Provider paths saved. Connect again to use the new configuration.', connected: false });
      return this.providerSettingsSnapshot();
    });
  }

  private providerSettingsSnapshot(): ProviderSetting[] {
    const inherited = reaHostEnvironment(this.baselineEnvironment, this.options.environment);
    return PROVIDER_SETTINGS.map(definition => ({ ...definition, path: this.providerOverrides.get(definition.id) ?? inherited[definition.environmentKey] ?? '', overridden: this.providerOverrides.has(definition.id) }));
  }

  private async loadProviderSettings(): Promise<void> {
    if (this.settingsLoaded) return;
    if (this.settingsLoading) return this.settingsLoading;
    this.settingsLoading = (async () => {
      let fileFound = false;
      try {
        const path = join(this.options.dataDir, 'provider-settings.json');
        const info = await this.filesystem.stat(path);
        fileFound = true;
        if (!info.isFile() || info.size > 65_536) throw new Error('Provider settings must be a bounded regular JSON file.');
        const document = JSON.parse(await this.filesystem.readFile(path, 'utf8'));
        if (!isRecord(document) || document.version !== 1 || !isRecord(document.paths) || Object.keys(document).some(key => !['version', 'paths'].includes(key))) throw new Error('Invalid provider settings document.');
        const loaded = new Map<ProviderSettingId, string>();
        for (const [id, value] of Object.entries(document.paths)) {
          const definition = PROVIDER_SETTINGS.find(setting => setting.id === id);
          if (!definition || typeof value !== 'string') throw new Error('Unknown or invalid provider setting.');
          loaded.set(definition.id, await this.normalizeProviderPath(definition, value));
        }
        this.providerOverrides = loaded;
      } catch (error: any) {
        if (fileFound || error?.code !== 'ENOENT') {
          // Never reflect JSON parse excerpts or unrecognized environment values into the renderer.
          this.state.error = 'Saved provider settings were rejected. Choose provider paths again to replace the invalid file.';
          this.emit({ type: 'status', text: this.state.error, error: true });
        }
        this.providerOverrides.clear();
      } finally { this.settingsLoaded = true; this.settingsLoading = undefined; }
    })();
    return this.settingsLoading;
  }

  private async normalizeProviderPath(definition: ProviderDefinition, path: string): Promise<string> {
    if (!path || !isAbsolute(path) || path.includes('\0')) throw new Error('Choose an existing absolute provider path.');
    let canonical = await this.filesystem.realpath(path);
    let info = await this.filesystem.stat(canonical);
    if (definition.id === 'java' && info.isDirectory()) {
      const bundleHome = join(canonical, 'Contents', 'Home');
      if (/\.jdk$/iu.test(canonical)) { canonical = await this.filesystem.realpath(bundleHome); info = await this.filesystem.stat(canonical); }
      const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
      const compilerName = process.platform === 'win32' ? 'javac.exe' : 'javac';
      const [runtime, compiler] = await Promise.all([this.filesystem.stat(join(canonical, 'bin', javaName)), this.filesystem.stat(join(canonical, 'bin', compilerName))]).catch(() => { throw new Error('Choose a full Java JDK containing bin/java and bin/javac.'); });
      if (!runtime.isFile() || !compiler.isFile()) throw new Error('Choose a full Java JDK containing bin/java and bin/javac.');
    }
    if (definition.id === 'hopper' && info.isDirectory() && /\.app$/iu.test(canonical)) {
      let launcher: string | undefined;
      for (const name of ['hopper', 'Hopper']) {
        const candidate = join(canonical, 'Contents', 'MacOS', name);
        try { if ((await this.filesystem.stat(candidate)).isFile()) { launcher = await this.filesystem.realpath(candidate); break; } } catch { /* Try the observed Hopper launcher capitalization. */ }
      }
      if (!launcher) throw new Error('Selected Hopper bundle has no supported Contents/MacOS/hopper executable.');
      canonical = launcher; info = await this.filesystem.stat(canonical);
    }
    if (definition.kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw new Error(`Choose a ${definition.kind} for ${definition.label}.`);
    // Python venv selection depends on argv[0]'s directory; resolving its symlink
    // to the system interpreter would discard the chosen installed packages.
    return definition.id === 'pwntools' ? resolve(path) : canonical;
  }

  private snapshot(): EngineStatus { return { ...this.state, target: this.state.target && { ...this.state.target }, tools: this.state.tools.map(tool => ({ ...tool })) }; }

  private runtimeArguments(args: string[]): string[] { return [...(this.options.runtimeBootstrapPath ? [this.options.runtimeBootstrapPath] : []), this.options.entryPath, ...args]; }

  private emit(event: Omit<EngineEvent, 'timestamp'>) {
    const complete = { ...event, timestamp: new Date().toISOString() } as EngineEvent;
    if (complete.text) complete.text = redact(complete.text).slice(0, 4096);
    for (const listener of this.listeners) { try { listener(complete); } catch { /* Observer failures cannot stop engine cleanup. */ } }
  }

  private async exclusive<T>(label: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('REA engine has been disposed.');
    if (this.resetting) throw new Error('REA workspace is resetting.');
    if (this.state.busy) throw new Error('REA is busy. Cancel the current operation or wait for it to finish.');
    this.state.busy = true; this.state.error = undefined;
    const controller = new AbortController(); this.controller = controller;
    let resolveDone!: () => void;
    const done = new Promise<void>(resolvePromise => { resolveDone = resolvePromise; });
    this.activeDone = done;
    const timeout = setTimeout(() => controller.abort(new Error('REA operation timed out.')), this.options.requestTimeoutMs ?? 300_000);
    this.emit({ type: 'status', text: label, busy: true });
    try { return await action(controller.signal); }
    catch (error) {
      this.state.error = errorText(error);
      if (controller.signal.aborted) await this.disconnectInternal();
      this.emit({ type: 'status', text: this.state.error, error: true });
      throw new Error(this.state.error);
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
      this.state.busy = false;
      this.emit({ type: 'status', text: controller.signal.aborted ? 'Operation stopped' : 'Ready', busy: false });
      resolveDone();
      if (this.activeDone === done) this.activeDone = undefined;
    }
  }

  private childEnvironment(): Record<string, string> {
    // Only this app's saved settings and explicit main-process options configure providers.
    const environment = reaHostEnvironment(this.baselineEnvironment, this.options.environment);
    for (const definition of PROVIDER_SETTINGS) { const path = this.providerOverrides.get(definition.id); if (path !== undefined) environment[definition.environmentKey] = path; }
    delete environment.HOPPER_TARGET_PATH; delete environment.HOPPER_TARGET_KIND; delete environment.HOPPER_LOADER_ARGS_JSON;
    if (environment.GHIDRA_INSTALL_DIR && !environment.REA_ANALYSIS_PROVIDER) environment.REA_ANALYSIS_PROVIDER = 'ghidra';
    environment.REA_LOG_LEVEL = 'error';
    environment.REA_MCP_MAX_RESPONSE_BYTES = String(10 * 1024 * 1024);
    environment.TMPDIR = join(this.options.dataDir, 'tmp');
    environment.TMP = environment.TMPDIR; environment.TEMP = environment.TMPDIR;
    // Provider discovery and doctor audits must never read another application's profiles.
    const home = join(this.options.dataDir, 'engine-home');
    environment.HOME = home; environment.USERPROFILE = home;
    environment.XDG_CONFIG_HOME = join(home, '.config');
    environment.XDG_CACHE_HOME = join(home, '.cache');
    environment.APPDATA = join(home, 'AppData', 'Roaming');
    environment.LOCALAPPDATA = join(home, 'AppData', 'Local');
    return environment;
  }

  private async connectInternal(signal: AbortSignal) {
    if (this.client && this.state.connected) return;
    await this.loadProviderSettings();
    await this.filesystem.mkdir(this.options.dataDir, { recursive: true });
    await this.filesystem.mkdir(join(this.options.dataDir, 'tmp'), { recursive: true });
    await this.filesystem.mkdir(join(this.options.dataDir, 'engine-home'), { recursive: true, mode: 0o700 });
    await this.filesystem.mkdir(join(this.options.dataDir, 'outputs'), { recursive: true });
    this.state.outputDirectory = join(this.options.dataDir, 'outputs');
    await this.filesystem.stat(this.options.entryPath);
    if (this.options.runtimeBootstrapPath) await this.filesystem.stat(this.options.runtimeBootstrapPath);
    const generation = ++this.generation;
    this.logs = '';
    const transport = new StdioClientTransport({ command: this.options.runtimePath ?? process.execPath, args: this.runtimeArguments(['mcp']), cwd: this.options.dataDir, env: this.childEnvironment(), stderr: 'pipe', maxBufferSize: MAX_RESULT_BYTES });
    transport.stderr?.on('data', chunk => this.log(chunk.toString('utf8'), 'stderr'));
    const client = new Client({ name: 'rea-workbench', version: '0.1.0' });
    this.transport = transport; this.client = client;
    client.onerror = error => this.log(errorText(error), 'transport');
    client.onclose = () => {
      if (this.generation !== generation) return;
      this.state.connected = false; this.opened = false;
      this.emit({ type: 'status', text: 'REA connection closed', connected: false });
    };
    try {
      await client.connect(transport, { signal, timeout: 60_000 });
      if (signal.aborted) throw signal.reason;
      const tools: any[] = [];
      let cursor: string | undefined; const cursors = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: 60_000 });
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('REA returned a repeating tool inventory cursor.');
        if (cursor) cursors.add(cursor);
        if (tools.length > 1000) throw new Error('REA tool inventory exceeded the configured bound.');
      } while (cursor);
      this.definitions = new Map(tools.map(tool => [tool.name, tool]));
      this.state.tools = tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
      this.state.toolCount = tools.length; this.state.version = client.getServerVersion()?.version; this.state.connected = true;
      await this.refreshAvailability(signal);
      this.emit({ type: 'status', text: `REA ${this.state.version ?? ''} connected with ${tools.length} tools`, connected: true });
    } catch (error) {
      await this.disconnectInternal();
      const diagnostic = this.logs.trim();
      throw new Error(`REA startup failed: ${errorText(error)}${diagnostic ? `\n${diagnostic.slice(-4096)}` : '\nVerify the bundled runtime and REA prerequisites; sandboxed hosts must permit the owned stdio child process.'}`);
    }
  }

  private async disconnectInternal() {
    ++this.generation;
    this.providerProbes.clear();
    const client = this.client; const transport = this.transport;
    this.client = undefined; this.transport = undefined;
    this.state.connected = false; this.opened = false; this.openedTargetId = undefined;
    await Promise.allSettled([client?.close(), transport?.close()]);
  }

  private async refreshAvailability(signal: AbortSignal) {
    if (!this.client) return;
    const response = await this.client.callTool({ name: 'binary_session', arguments: {} }, { signal, timeout: 60_000, toolDefinition: this.definitions.get('binary_session') });
    const session = this.payload(response as ReaResult)?.result;
    const availability = session?.tool_availability;
    const rows: any[] = Array.isArray(availability) ? availability : isRecord(availability) ? Object.entries(availability).map(([name, value]) => ({ name, ...(isRecord(value) ? value : {}) })) : [];
    const statusMap = new Map(rows.map(row => [row.name ?? row.operation ?? row.tool, row]));
    // REA 6.4.0 registers ADB/Apktool handlers but omits their readiness from
    // binary_session. Correct only that omission after real, non-device probes.
    for (const [kind, name] of [['adb-provider', 'inspect_adb_client'], ['apktool-provider', 'inspect_apktool_client']]) {
      if (this.providerProbes.has(kind) || !rows.some(row => (row.kind ?? row.surface) === kind && row.reason === 'provider_missing') || !this.definitions.has(name)) continue;
      try {
        const result = await this.invoke(name, {}, signal, false);
        const payload = this.payload(result);
        this.providerProbes.set(kind, { available: !result.isError && !payload?.error && !!payload?.evidence_id, result });
      } catch (error) {
        if (signal.aborted) throw error;
        this.providerProbes.set(kind, { available: false, result: { isError: true, content: [{ type: 'text', text: errorText(error) }] } });
      }
    }
    this.state.tools = this.state.tools.map(tool => {
      const row = statusMap.get(tool.name);
      if (!row) return tool;
      const probe = this.providerProbes.get(row.kind ?? row.surface);
      const corrected = row.reason === 'provider_missing' && probe?.available;
      const remediation = corrected ? (row.kind ?? row.surface) === 'adb-provider' ? 'ADB client verified. Device operations require an authorized device and valid serial; no device was contacted by the probe.' : 'Apktool client verified. Resource decoding requires a valid selected APK.' : row.remediation;
      return { ...tool, available: corrected ? true : row.available ?? row.status === 'available', reason: [corrected ? 'verified_provider' : row.reason, remediation].filter(Boolean).join(': '), reasonCode: corrected ? 'verified_provider' : row.reason, remediation, kind: row.kind ?? row.surface, upstreamAvailability: { ...row }, ...(corrected ? { readinessEvidence: this.payload(probe.result)?.evidence_id } : {}) };
    });
  }

  private async invoke(name: string, args: Record<string, any>, signal: AbortSignal, retain = true, meta?: Record<string, any>): Promise<ReaResult> {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`The connected REA server does not advertise ${name}.`);
    if (!this.client) throw new Error('REA is disconnected.');
    this.emit({ type: 'progress', text: name, phase: 'started' });
    const result = await this.client.callTool({ name, arguments: args }, {
      signal,
      timeout: name === 'analyze_javascript_application' ? Math.max(this.options.requestTimeoutMs ?? 300_000, (args.analysis_timeout_ms ?? 300_000) + 60_000) : this.options.requestTimeoutMs ?? 300_000,
      toolDefinition: definition,
      onprogress: progress => this.emit({ type: 'progress', text: progress.message ?? name, progress: progress.progress, total: progress.total }),
    }) as ReaResult;
    if (signal.aborted) throw signal.reason;
    // REA transports failures as JSON text, with successful Evidence in structuredContent.
    if (result.structuredContent === undefined) {
      const payload = this.payload(result);
      if (payload !== undefined) result.structuredContent = payload;
    }
    result.meta = { ...(isRecord(result.meta) ? result.meta : {}), ...meta, operation: name };
    if (retain && this.state.target && name !== 'binary_session') {
      const records = join(this.options.dataDir, 'records', this.state.target.id);
      await this.filesystem.mkdir(records, { recursive: true });
      const file = join(records, `${Date.now()}-${name}-${randomUUID().slice(0, 8)}.json`);
      const text = JSON.stringify({ operation: name, target: this.state.target, arguments: args, result }, null, 2);
      if (Buffer.byteLength(text) > MAX_RESULT_BYTES) throw new Error('REA returned more than the 12 MiB delivery bound. Export its retained evidence through the tool browser.');
      await this.atomicWrite(file, text);
      const payload = result.structuredContent;
      const normalized = payload?.normalized_result ?? payload?.result;
      this.observations.push({ operation: name, timestamp: new Date().toISOString(), file, error: !!result.isError, evidenceId: normalized?.parent_evidence_id ?? payload?.evidence_id, summary: normalized?.summary ?? normalized?.statistics ?? payload?.summary });
      if (!result.isError && !/^(export_evidence_bundle|get_evidence_bundle)$/.test(name)) {
        try {
          const saved = await this.results.capture({ target: this.state.target, operation: name, arguments: args, result, evidenceId: normalized?.parent_evidence_id ?? payload?.evidence_id });
          result.meta.results = saved;
          this.emit({ type: 'progress', text: `${saved.saved} files saved to Results`, phase: 'results', warnings: saved.warnings });
          if (saved.warnings.length) this.log(`Results retention needs attention: ${saved.warnings.join('; ')}`, 'results');
        } catch (error) { result.meta.results = { saved: 0, warnings: [errorText(error)] }; this.log(`Results retention failed: ${errorText(error)}`, 'results'); this.emit({ type: 'progress', phase: 'results', text: 'Results retention failed', warnings: result.meta.results.warnings }); }
        await this.atomicWrite(file, JSON.stringify({ operation: name, target: this.state.target, arguments: args, result }, null, 2));
      }
      if (!result.isError && name !== 'export_evidence_bundle' && name !== 'get_evidence_bundle') {
        // Persist retained parent records as well as summary responses before a later cancellation.
        const snapshotPath = join(records, `evidence-session-${this.generation}.json`);
        const snapshot = await this.client.callTool({ name: 'export_evidence_bundle', arguments: { path: snapshotPath, overwrite: true } }, { signal, timeout: 60_000, toolDefinition: this.definitions.get('export_evidence_bundle') }) as ReaResult;
        if (snapshot.isError) this.log(`Canonical Evidence snapshot failed: ${this.toolError(snapshot)}`, 'retention');
        else this.evidenceSnapshots.add(snapshotPath);
      }
    }
    this.emit({ type: 'progress', text: result.isError ? this.toolError(result) : `${name} complete`, phase: result.isError ? 'failed' : 'complete' });
    return result;
  }

  private payload(result: ReaResult): any {
    if (result.structuredContent !== undefined) return result.structuredContent;
    for (const item of result.content ?? []) if (item.type === 'text' && typeof item.text === 'string') { try { return JSON.parse(item.text); } catch { /* Text-only provider output remains readable. */ } }
    return undefined;
  }
  private toolError(result: ReaResult): string {
    const payload = this.payload(result);
    return errorText(payload?.error?.message ?? payload?.error ?? result.content?.find(item => item.type === 'text')?.text ?? 'REA tool failed.');
  }

  private log(chunk: string, stream: string) {
    const clean = redact(chunk);
    this.logs = (this.logs + clean).slice(-MAX_LOG_BYTES);
    this.emit({ type: 'log', text: clean.slice(-4096), stream });
  }

  private async runCli(args: string[], signal: AbortSignal): Promise<any> {
    return new Promise((resolvePromise, reject) => {
      let stdout = ''; let stderr = ''; let bytes = 0; let finished = false;
      const child = spawn(this.options.runtimePath ?? process.execPath, this.runtimeArguments(args), { cwd: this.options.dataDir, env: this.childEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.doctorChild = child;
      const stop = () => { child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 2000); force.unref(); };
      const complete = (error?: Error, value?: any) => {
        if (finished) return; finished = true;
        signal.removeEventListener('abort', stop);
        if (this.doctorChild === child) this.doctorChild = undefined;
        error ? reject(error) : resolvePromise(value);
      };
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      child.stdout?.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_RESULT_BYTES) { stop(); complete(new Error('REA diagnostic output exceeded 12 MiB.')); } else stdout += chunk.toString('utf8'); });
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-MAX_LOG_BYTES); this.log(chunk.toString('utf8'), 'stderr'); });
      child.on('error', error => complete(error));
      child.on('close', (code, exitSignal) => {
        if (signal.aborted) return complete(new Error(errorText(signal.reason)));
        try { const report = JSON.parse(stdout.trim()); complete(undefined, { ...report, cliExitCode: code }); }
        catch { complete(new Error(`REA diagnostic did not return JSON (exit ${code ?? exitSignal ?? 'unknown'}). ${redact(stderr).slice(-2048)}`)); }
      });
    });
  }

  private async validatePaths(input: unknown, key = '', tool = ''): Promise<void> {
    if (typeof input === 'string' && PATH_KEY.test(key)) {
      const writing = key.startsWith('output_') || (key === 'snapshot_path' && tool === 'close_binary') || (key === 'path' && tool === 'export_evidence_bundle');
      if (writing) await this.authorizedOutputPath(input);
      else if (isAbsolute(input)) await this.authorizedPath(input, false);
      else if (key !== 'path' || input.split(/[\\/]/u).includes('..') || input.includes('\0')) throw new Error(`Use an authorized absolute ${key}.`);
      return;
    }
    if (Array.isArray(input)) { for (const item of input) await this.validatePaths(item, key, tool); }
    else if (isRecord(input)) { for (const [name, value] of Object.entries(input)) await this.validatePaths(value, name, tool); }
  }

  private async authorizedOutputPath(path: string): Promise<string> {
    const canonical = await this.authorizedPath(path, true);
    const dataRoot = await this.filesystem.realpath(this.options.dataDir);
    const rel = relative(dataRoot, canonical);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('REA tool outputs must stay in the host REA data directory. Use the Export dialog to save elsewhere.');
    for (const target of this.targets.values()) {
      const sourceRelative = relative(target.path, canonical);
      if (canonical === target.path || (target.kind === 'directory' && sourceRelative !== '..' && !sourceRelative.startsWith(`..${sep}`) && !isAbsolute(sourceRelative))) throw new Error('REA tool outputs cannot overwrite or write inside the selected source target.');
    }
    return canonical;
  }

  private async authorizedPath(path: string, allowMissing: boolean): Promise<string> {
    if (!isAbsolute(path) || path.includes('\0')) throw new Error('Use an absolute local path.');
    const candidate = resolve(path);
    let canonical: string;
    try { canonical = await this.filesystem.realpath(candidate); }
    catch (error: any) {
      if (!allowMissing || error.code !== 'ENOENT') throw error;
      let parent = dirname(candidate); const tail: string[] = [basename(candidate)];
      while (true) { try { canonical = join(await this.filesystem.realpath(parent), ...tail.reverse()); break; } catch (cause: any) { if (cause.code !== 'ENOENT' || parent === dirname(parent)) throw cause; tail.push(basename(parent)); parent = dirname(parent); } }
    }
    const dataRoot = await this.filesystem.realpath(this.options.dataDir).catch(() => this.options.dataDir);
    const inside = (root: string) => { const rel = relative(root, canonical); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); };
    if (inside(dataRoot)) return canonical;
    for (const [path, kind] of this.toolInputs) if (kind === 'directory' ? inside(path) : canonical === path) return canonical;
    for (const target of this.targets.values()) if (target.kind === 'directory' ? inside(target.path) : canonical === target.path) return canonical;
    // Dependencies configured by the host are valid executable selectors, never arbitrary renderer paths.
    const configuredPaths = this.providerSettingsSnapshot().map(setting => setting.path);
    const dependencies = [this.options.runtimePath ?? process.execPath, this.options.runtimeBootstrapPath, ...configuredPaths].filter(value => value && isAbsolute(value));
    for (const dependency of dependencies) if (dependency && await this.filesystem.realpath(dependency).catch(() => dependency) === canonical) return canonical;
    throw new Error('This path is outside the selected target and REA output directory. Select the target through the host file dialog.');
  }

  private renderDossier(target: Target, evidencePath: string, archivedBundles: string[], allObservations: Observation[], sources: string[] = []): string {
    const observations = allObservations.slice(-100);
    return [
      `# REA dossier: ${target.name}`, '',
      `Generated: ${new Date().toISOString()}`, `Target: ${target.path}`, `REA version: ${this.state.version ?? 'unknown'}`, '',
      'This report records REA analysis and Workbench static source reads. REA Evidence and directly read source bytes remain distinct. Static observations do not establish runtime behavior. Unavailable providers, inferred relationships, and coverage limits remain in the exported records.', '',
      '## Portable Evidence', '', `Current canonical session bundle: [${evidencePath}](${evidencePath})`,
      ...archivedBundles.map(path => `Completed-operation session snapshot: [${path}](${path})`), '',
      'Complete call records are included in the records/ folder. Keep this report with its adjacent Evidence files and records folder when sharing it.', '',
      ...(sources.length ? ['## Selected source snapshot', '', 'Exact selected bytes and their Workbench provenance are included below. The synthetic application entry adds no sibling files; unresolved external imports remain a coverage limit.', '', ...sources.map(path => `[${path}](${path.split('/').map(encodeURIComponent).join('/')})`), ''] : []),
      '## Recorded operations', '',
      ...observations.flatMap(record => [
        `### ${record.operation}`, '', `Time: ${record.timestamp}`, `Outcome: ${record.kind === 'static-bytes' ? 'Read static source bytes' : record.error ? 'Tool reported an error' : 'Returned analysis'}`,
        ...(record.kind === 'static-bytes' ? ['Authority: Workbench static bytes; separate from REA Evidence.'] : []),
        ...(record.evidenceId ? [`Evidence: ${record.evidenceId}`] : []), `Complete tool record: [${basename(record.file)}](records/${basename(record.file)})`, '',
        ...(record.summary !== undefined ? ['```json', JSON.stringify(record.summary, null, 2).slice(0, 8000), '```', ''] : []),
      ]),
      '## Coverage', '',
      `Recorded operations in this target session: ${allObservations.length}. ${allObservations.length > 100 ? 'This Markdown indexes the latest 100; every earlier complete call record is included in records/ and completed Evidence remains in the session snapshots.' : 'Every recorded operation is indexed above.'}`,
      'Read each Evidence record for limitations, inference authority, target digests, provider identity, and unresolved findings. This dossier does not claim that the target was fully reconstructed or executed.', '',
    ].join('\n');
  }

  private async atomicWrite(path: string, content: string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await this.filesystem.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await this.filesystem.rename(temporary, path);
  }
}
