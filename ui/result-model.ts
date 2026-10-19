import type { EngineStatus, ReaResult, ReaTool, Target } from '../shared/types';

export type RecordEntry = { id: string; name: string; at: string; arguments: Record<string, any>; result: ReaResult };
export type SymbolEntry = { key: string; name: string; address?: string; raw: Record<string, any> };
export type Profile = 'Native' | 'JavaScript' | 'Go' | '.NET' | 'Android';

export function unpack(result: ReaResult | undefined): any {
  if (!result) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  for (const item of result.content || []) {
    if (item.type === 'text' && item.text) { try { return JSON.parse(item.text); } catch { /* Keep original text available. */ } }
  }
  return result;
}

export function readable(result: ReaResult | undefined): string {
  if (!result) return '';
  const text = (result.content || []).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n\n');
  return text || JSON.stringify(result.structuredContent ?? result, null, 2);
}

function walk(value: any, visit: (key: string, value: any) => void, level = 0): void {
  if (!value || typeof value !== 'object' || level > 5) return;
  for (const [key, item] of Object.entries(value)) {
    visit(key, item);
    if (!Array.isArray(item)) walk(item, visit, level + 1);
  }
}

export function symbolsFrom(result: ReaResult | undefined, operation = ''): SymbolEntry[] {
  const envelope = unpack(result);
  const data = envelope?.normalized_result ?? envelope?.result ?? envelope;
  let rows: any[] = Array.isArray(data) && /list.*(procedures|functions|symbols)/.test(operation || envelope?.operation || '') ? data : [];
  walk(data, (key, item) => { if (/^(procedures|functions|symbols|methods|exports)$/i.test(key) && Array.isArray(item) && item.length > rows.length) rows = item; });
  return rows.filter(item => item && typeof item === 'object').map(item => Array.isArray(item) ? { address: item[0], name: item[1] } : item).map((item, index) => ({
    key: String(item.address ?? item.addr ?? item.entry_point ?? item.start ?? item.name ?? index),
    name: String(item.name ?? item.value ?? item.function_name ?? item.symbol ?? item.method ?? `Function ${index + 1}`),
    address: item.address !== undefined || item.addr !== undefined || item.entry_point !== undefined || item.start !== undefined ? String(item.address ?? item.addr ?? item.entry_point ?? item.start) : undefined,
    raw: item,
  }));
}

export function entriesFrom(result: ReaResult | undefined, kind: 'strings' | 'xrefs' | 'modules'): any[] {
  const envelope = unpack(result);
  const data = envelope?.normalized_result ?? envelope?.result ?? envelope;
  const names = kind === 'modules' ? /^(modules|scripts|files|entries|items)$/i : kind === 'xrefs' ? /^(xrefs|references|callers|calls|results)$/i : /^(strings|matches|results)$/i;
  let rows: any[] = Array.isArray(data) ? data : [];
  walk(data, (key, item) => { if (names.test(key) && Array.isArray(item) && item.length > rows.length) rows = item; });
  return rows;
}

export function codeFrom(result: ReaResult | undefined, tab: string): string {
  const envelope = unpack(result);
  const data = envelope?.normalized_result ?? envelope?.result ?? envelope;
  const names = tab === 'Pseudocode' ? /^(pseudocode|pseudo_code|decompiled|decompiled_code|decompilation)$/i : tab === 'Assembly' ? /^(assembly|disassembly|asm|instructions)$/i : /^(source|source_code|source_text|code|javascript|decompiled_source)$/i;
  if (typeof data === 'string' && ((tab === 'Pseudocode' && /pseudo|decompile/.test(envelope?.operation || '')) || (tab === 'Assembly' && /assembly|disassembly/.test(envelope?.operation || '')) || (tab === 'Source' && /source|javascript/.test(envelope?.operation || '')))) return data;
  let found: any;
  walk(data, (key, value) => { if (found === undefined && names.test(key)) found = value; });
  if (found !== undefined) return typeof found === 'string' ? found : JSON.stringify(found, null, 2);
  return '';
}

export function toolFor(tools: ReaTool[], operation: string, profile: Profile = 'Native'): ReaTool | undefined {
  const patterns: Record<string, RegExp[]> = {
    functions: [/^list_procedures$/, /^list_functions$/, /list.*functions/, /list.*symbols/],
    decompile: [/^procedure_pseudo_code$/, /^decompile_function$/, /decompile.*function/],
    strings: [/^search_strings$/, /search.*strings/],
    assembly: [/^procedure_assembly$/],
    xrefs: [/^xrefs$/, /^find_xrefs$/, /find.*xrefs/, /cross.*references/],
    dossier: [/^analyze_function$/, /^generate_dossier$/, /generate.*dossier/],
    analyze: profile === 'JavaScript' ? [/^analyze_javascript_application$/, /analy[sz]e.*javascript/, /inspect.*electron/] : profile === '.NET' ? [/^inspect_managed_artifact$/, /inspect.*managed/] : profile === 'Android' ? [/^inspect_android_package$/, /inspect.*android/] : profile === 'Go' ? [/^open_binary$/] : [/^open_binary$/],
  };
  const candidates = patterns[operation] || [];
  for (const pattern of candidates) { const match = tools.find(tool => pattern.test(tool.name)); if (match) return match; }
  return undefined;
}

export function argumentsFor(tool: ReaTool, target?: Target, symbol?: SymbolEntry, query?: string, records: RecordEntry[] = []): Record<string, any> {
  const args: Record<string, any> = {};
  const rootSchema = resolveSchema(tool.inputSchema, tool.inputSchema);
  const properties = rootSchema.properties || {};
  const runtime: Record<string, any> = {};
  for (const record of records) walk(unpack(record.result), (key, value) => { if (/^(document|session_id|sessionId|binary_id|binaryId|artifact_id|artifactId|project_id|projectId|target_id|targetId)$/.test(key) && ['string','number'].includes(typeof value)) runtime[key] = value; });
  for (const [key, value] of Object.entries(properties)) {
    const schema = resolveSchema(value, tool.inputSchema);
    if (Object.prototype.hasOwnProperty.call(schema, 'default')) args[key] = schema.default;
    if (key in runtime) args[key] = runtime[key];
    if (target && /^(path|file_path|binary_path|directory|directory_path|root|root_path|artifact_path|apk_path|input_path|source_path|app_path|project_path)$/.test(key)) args[key] = target.path;
    if (target && /^(target_id|targetId)$/.test(key) && !('cdp_endpoint' in properties)) args[key] = target.id;
    if (symbol && /^(procedure|address|addr|function_address|functionAddress)$/.test(key) && symbol.address !== undefined) args[key] = symbol.address;
    if (symbol && /^(name|function_name|symbol|function)$/.test(key)) args[key] = symbol.name;
    if (query !== undefined && /^(query|pattern|search|search_term|text|needle)$/.test(key)) args[key] = query;
  }
  return args;
}

export function missingRequired(tool: ReaTool, args: Record<string, any>): string[] {
  return (resolveSchema(tool.inputSchema, tool.inputSchema)?.required || []).filter((key: string) => args[key] === undefined || args[key] === '');
}
export function stripControls(text: string): string { return text.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '').replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); }

export function resolveSchema(schema: any, root: any, depth = 0): any {
  if (!schema || typeof schema !== 'object' || depth > 8) return schema || {};
  let result = { ...schema };
  if (schema.$ref?.startsWith('#/')) {
    const pointed = schema.$ref.slice(2).split('/').reduce((value: any, key: string) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    if (pointed) result = { ...resolveSchema(pointed, root, depth + 1), ...result };
  }
  if (result.allOf) for (const part of result.allOf) {
    const child = resolveSchema(part, root, depth + 1);
    result = { ...child, ...result, properties: { ...child.properties, ...result.properties }, required: Array.from(new Set([...(child.required || []), ...(result.required || [])])) };
  }
  if (!result.type && (result.anyOf || result.oneOf)) {
    const options = (result.anyOf || result.oneOf).map((part: any) => resolveSchema(part, root, depth + 1));
    const nonNull = options.filter((part: any) => part.type !== 'null');
    if (nonNull.length === 1) result = { ...nonNull[0], ...result, type: nonNull[0].type };
  }
  return result;
}

export function highlightedLine(line: string): Array<{ text: string; kind?: string }> {
  const tokens: Array<{ text: string; kind?: string }> = [];
  const pattern = /(\/\/.*$|#.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:if|else|while|for|return|function|const|let|var|class|public|private|static|void|int|char|bool|unsigned|long|struct|switch|case|break|continue|import|from|export|async|await|try|catch|new|throw|null|undefined|true|false)\b|\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)\b)/g;
  let index = 0;
  for (const match of line.matchAll(pattern)) {
    const offset = match.index || 0;
    if (offset > index) tokens.push({ text: line.slice(index, offset) });
    const text = match[0];
    tokens.push({ text, kind: /^(\/\/|#|\/\*)/.test(text) ? 'comment' : /^["']/.test(text) ? 'string' : /^(0x|\d)/.test(text) ? 'number' : 'keyword' });
    index = offset + text.length;
  }
  if (index < line.length) tokens.push({ text: line.slice(index) });
  return tokens.length ? tokens : [{ text: ' ' }];
}

export type HealthRow = { name: string; status: 'available' | 'unavailable' | 'unknown'; detail: string; category: 'connection' | 'environment' | 'provider' | 'registration' | 'audit'; stateLabel?: string };
export function healthRows(data: any, connection?: Pick<EngineStatus, 'connected' | 'version'>): HealthRow[] {
  const rows: HealthRow[] = [];
  const providers: any[] = Array.isArray(data?.providerInspections) ? data.providerInspections : [];
  if (connection) rows.push({ name: 'Workbench MCP connection', category: 'connection', status: connection.connected ? 'available' : 'unavailable', stateLabel: connection.connected ? 'Connected' : 'Disconnected', detail: connection.connected ? `REA ${connection.version || 'engine'} is connected to this workspace through its owned stdio session.` : 'Connect the engine to discover and invoke its advertised tools.' });
  function categoryFor(name: string): HealthRow['category'] {
    if (/^registration:|client registration|skill/i.test(name)) return 'registration';
    return providers.some(provider => name.toLowerCase().startsWith(String(provider.id || '').toLowerCase()) && provider.id) || /hopper|ghidra|jadx|ilspy|radare|ida(?:$|[-:])/i.test(name) ? 'provider' : 'environment';
  }
  function add(item: any, fallback?: string, category?: HealthRow['category']) {
    if (!item || typeof item !== 'object') return;
    const rawName = item.name ?? item.label ?? item.id ?? item.component ?? item.tool ?? fallback;
    const name = rawName === undefined ? '' : String(rawName);
    const value = item.available ?? item.healthy ?? item.ok ?? item.passed ?? item.present;
    const namedStatus = String(item.status ?? '').toLowerCase();
    const group = category ?? categoryFor(name);
    const status = value === true || /^(ok|pass|passed|available|healthy)$/.test(namedStatus) ? 'available' : value === false || /^(failed|error|unavailable|missing|not-installed)$/.test(namedStatus) ? 'unavailable' : 'unknown';
    const detail = String(item.message ?? item.reason ?? item.detail ?? item.version ?? item.path ?? (item.configured === false ? 'Not configured; workflows requiring this provider remain unavailable.' : 'See the complete diagnostic for details.'));
    if (name) rows.push({ name, category: group, status, ...(group === 'registration' ? { stateLabel: status === 'available' ? 'Aligned' : status === 'unavailable' ? 'Needs attention' : 'Unknown' } : {}), detail: group === 'registration' ? `${detail} External client registration is separate from the Workbench stdio connection.` : detail });
    if (Array.isArray(item.checks)) item.checks.forEach((check: any) => add(check, undefined, group));
  }
  if (data && typeof data === 'object') {
    if (typeof data.healthy === 'boolean') rows.push({ name: 'Doctor prerequisite audit', category: 'audit', status: data.healthy ? 'available' : 'unavailable', stateLabel: data.healthy ? 'Checks passed' : 'Needs attention', detail: 'This audit combines host, provider and external registration checks. Its overall verdict does not report the live Workbench MCP connection.' });
    for (const key of ['checks', 'scope_checks', 'providerInspections', 'providers', 'dependencies']) {
      const group = key === 'providerInspections' || key === 'providers' ? 'provider' : undefined;
      if (Array.isArray(data[key])) data[key].forEach((item: any) => add(item, undefined, group));
      else if (data[key] && typeof data[key] === 'object') for (const [name, item] of Object.entries(data[key])) add(typeof item === 'boolean' ? { available: item } : item, name, group);
    }
    const registrations = data.identity?.registrations;
    if (Array.isArray(registrations)) for (const item of registrations) {
      const name = `registration:${item.client || 'external-client'}`;
      if (!rows.some(row => row.name === name)) add({ name, available: ['aligned', 'manual'].includes(item.state), detail: `${item.state || 'Unknown'}${item.config_path ? `: ${item.config_path}` : ''}` }, undefined, 'registration');
    }
  }
  for (const name of ['Node', 'Ghidra', 'Hopper', 'IDA', 'radare2']) if (!rows.some(row => row.name.toLowerCase().includes(name.toLowerCase()))) rows.push({ name, category: name === 'Node' ? 'environment' : 'provider', status: 'unknown', detail: 'This diagnostic did not return a status for this dependency.' });
  return rows.filter((row, index) => rows.findIndex(other => other.name === row.name) === index);
}

export function profileForTarget(target: Target): Profile {
  if (/\.app$/i.test(target.name)) return 'Native';
  if (/\.apk$/i.test(target.name)) return 'Android';
  if (/\.(dll|csproj)$/i.test(target.name)) return '.NET';
  return target.kind === 'directory' || /\.(js|mjs|cjs|ts|mts|cts|tsx|jsx|asar)$/i.test(target.name) ? 'JavaScript' : 'Native';
}
export function operationFrom(result: ReaResult, fallback = 'openTarget'): string {
  const envelope = unpack(result);
  const value = result.meta?.operation ?? envelope?.operation;
  return typeof value === 'string' && value ? value : fallback;
}
export function previewCode(text: string, maxCharacters = 65536, maxLines = 400, maxLineCharacters = 4000): { lines: Array<{ text: string; truncated: boolean }>; truncated: boolean; totalCharacters: number } {
  const window = text.slice(0, maxCharacters).split('\n');
  const lines = window.slice(0, maxLines).map(line => ({ text: line.slice(0, maxLineCharacters), truncated: line.length > maxLineCharacters }));
  return { lines, truncated: text.length > maxCharacters || window.length > maxLines || lines.some(line => line.truncated), totalCharacters: text.length };
}
export function availabilitySummary(tools: ReaTool[]) {
  const missing = tools.filter(tool => tool.available === false);
  const count = (pattern: RegExp) => missing.filter(tool => pattern.test(tool.reason || '')).length;
  return { advertised: tools.length, ready: tools.filter(tool => tool.available === true).length, unknown: tools.filter(tool => tool.available === undefined).length, missingProvider: count(/provider_missing|missing_dependency|not configured/i), targetRequired: count(/target_required|target_unsupported/i), unsupportedHost: count(/unsupported_host/i), clientRequired: count(/client_capability_missing/i), unavailable: missing.length };
}

export function modulesForTree(modules: any[]): Array<{ key: string; node_id?: string; path: string; name: string; role: string; raw: any }> {
  const seen = new Set<string>();
  return modules.flatMap((item, index) => {
    const raw = typeof item === 'string' ? { path: item } : item || {};
    const path = String(raw.relative_path ?? raw.path ?? raw.module_path ?? raw.file ?? raw.name ?? raw.node_id ?? `Module ${index + 1}`);
    const role = String(raw.kind ?? raw.role ?? raw.type ?? 'module');
    const node_id = raw.node_id === undefined ? undefined : String(raw.node_id);
    const key = node_id ?? `${role}:${path}:${index}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...raw, key, node_id, path, name: path.split('/').pop() || path, role, raw }];
  });
}
export function resultLimitations(result?: ReaResult): string[] {
  const envelope = unpack(result);
  const values: string[] = [];
  function collect(value: any) {
    if (typeof value === 'string' && value.trim()) values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') for (const [key, detail] of Object.entries(value)) {
      if (typeof detail === 'string') values.push(`${key}: ${detail}`);
      else if (detail === false) values.push(`${key}: unavailable`);
      else if (Array.isArray(detail)) detail.forEach(collect);
    }
  }
  collect(envelope?.limitations);
  collect(envelope?.normalized_result?.limitations);
  collect(envelope?.normalized_result?.unknowns);
  return Array.from(new Set(values));
}

export function partialAnalysis(result?: ReaResult): { statistics: string; reason?: string } | undefined {
  if (!result || result.isError) return undefined;
  const envelope = unpack(result);
  const normalized = envelope?.normalized_result ?? envelope?.result ?? envelope;
  const summary = normalized?.summary ?? normalized;
  const coverage = summary?.coverage;
  const scopes = [coverage?.application, coverage?.semantic, coverage];
  if (!scopes.some(scope => scope && (scope.status === 'partial' || scope.status === 'truncated' || scope.truncated === true))) return undefined;
  const statistics = summary?.statistics || {};
  const labels: Array<[string, string]> = [['parsed_javascript_files', 'parsed scripts'], ['findings', 'findings'], ['modules', 'recovered modules'], ['parse_failures', 'parse failures']];
  const counts = labels.filter(([key]) => typeof statistics[key] === 'number').map(([key, label]) => `${statistics[key]} ${label}`).join(' · ');
  const limitations = [...(Array.isArray(envelope?.limitations) ? envelope.limitations : []), ...(Array.isArray(normalized?.limitations) ? normalized.limitations : [])];
  const reason = limitations.find(value => typeof value === 'string' && /resource constraint|exhausted|out of memory|heap.*exceed|timeout|deadline.*exceed/i.test(value));
  return { statistics: counts, ...(reason ? { reason } : {}) };
}
