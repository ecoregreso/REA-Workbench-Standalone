import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { ResultFile, ResultDescription, ReaResult, Target } from './types';

type Filesystem = Pick<typeof fs, 'mkdir' | 'open' | 'realpath' | 'readdir' | 'lstat' | 'readFile' | 'writeFile' | 'rename' | 'copyFile' | 'rm'>;
type Capture = { target: Target; operation: string; arguments: Record<string, any>; result: ReaResult; evidenceId?: string };
const within = (root: string, path: string) => { const part = relative(root, path); return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)); };
const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const safeName = (text: string) => basename(text).replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 160) || 'recovered.txt';
const SAMPLE_BYTES = 1024 * 1024;
function routineBody(text: string, offset: number, declaration: string): { text: string; complete: boolean } {
  let start = offset + declaration.length;
  if (declaration.endsWith('{')) start--;
  while (/\s/.test(text[start] ?? '') && start < text.length) start++;
  if (text[start] !== '{') return { text: text.slice(start, text.indexOf('\n', start) < 0 ? text.length : text.indexOf('\n', start)).slice(0, 1200), complete: false };
  let depth = 0; let quote = ''; let lineComment = false; let blockComment = false;
  const end = Math.min(text.length, start + 65536);
  for (let index = start; index < end; index++) {
    const char = text[index], next = text[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index++; } continue; }
    if (quote) { if (char === '\\') index++; else if (char === quote) quote = ''; continue; }
    if (char === '/' && next === '/') { lineComment = true; index++; continue; }
    if (char === '/' && next === '*') { blockComment = true; index++; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++; else if (char === '}' && --depth === 0) return { text: text.slice(start + 1, index), complete: true };
  }
  return { text: text.slice(start + 1, end), complete: false };
}
const decodeText = (bytes: Buffer, truncated = false): string | undefined => {
  if (bytes.includes(0)) return undefined;
  for (let tail = 0; tail <= (truncated ? 3 : 0); tail++) {
    try { return new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, bytes.length - tail)); } catch { /* A sample may end inside a multibyte UTF-8 character. */ }
  }
  return undefined;
};
const languages: Record<string, string> = { '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.il': 'Managed bytecode', '.c': 'C', '.h': 'C / C++', '.cpp': 'C++', '.cc': 'C++', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.smali': 'Android bytecode', '.asm': 'Assembly', '.s': 'Assembly', '.json': 'JSON', '.xml': 'XML', '.map': 'Source map', '.txt': 'Text', '.md': 'Markdown' };

/** Local explanations cite literal static observations; no target code is executed. */
export function describeResult(name: string, text: string | undefined, bytes: number, kind: string): ResultDescription {
  const language = languages[extname(name).toLowerCase()] ?? (text === undefined ? 'Binary' : 'Text');
  const limits = ['This explanation is generated locally from static file contents. It does not prove runtime behavior or recover the author\'s intent.'];
  if (bytes > SAMPLE_BYTES) limits.push('The explanation examines the first 1 MiB. The complete file is saved and included in exports.');
  if (kind === 'pseudocode') limits.push('Decompiler output is a reconstruction; names, types and control flow may differ from the original source.');
  if (text === undefined) return { analysisVersion: 1, summary: `${name} is a saved binary artifact (${bytes.toLocaleString()} bytes).`, purpose: 'Its format or purpose cannot be established from a text inspection. It is retained alongside the recovered code for further analysis.', observations: [], functions: [], dependencies: [], limitations: [...limits, 'No readable UTF-8 source was available, so a code explanation is unavailable.'], language };
  const observations: Array<{ line: number; text: string; explanation: string }> = [];
  const rules: Array<[RegExp, string]> = [
    [/\b(fetch|XMLHttpRequest|axios\.|https?\.(get|request)|WebSocket|socket\()/, 'This code contains a network request or connection call. The destination and runtime outcome require further inspection.'],
    [/\b(readFile|writeFile|openSync|fopen|fwrite|File\.(Read|Write)|Files\.(read|write))\b/, 'This code references file access, which may read or write local data when reached.'],
    [/\b(localStorage|sessionStorage|indexedDB|SharedPreferences|sqlite|SQLITE|SELECT\s|INSERT\s)/, 'This code references persistent or session storage. It may retain application data between operations.'],
    [/\b(addEventListener|onClick|onCreate|subscribe|EventEmitter|\.on\()/, 'This code registers or refers to event handling, so some behavior may run in response to an external event.'],
    [/\b(document\.|querySelector|createElement|React\.|createRoot|setContentView|UIView)/, 'This code references user interface elements or rendering operations.'],
    [/\b(JSON\.parse|JSON\.stringify|json\.loads|deserialize|serialize|decode|encode)\b/, 'This code transforms data between representations, such as structured objects and encoded text.'],
    [/\b(crypto\.|createHash|SHA256|MessageDigest|encrypt|decrypt)\b/, 'This code references hashing or cryptographic operations. Their presence alone does not establish secure implementation.'],
    [/\b(throw|catch|except|panic|perror)\b/, 'This code includes an error path or error handling. Its effect depends on which conditions reach it.'],
    [/\b(for|while)\s*\(/, 'This code repeats operations using a loop. The loop condition determines which values are processed.'],
    [/\b(if|switch)\s*\(/, 'This code selects behavior based on a condition or value. Different inputs may take different paths.'],
    [/\b(return)\s+[^;\n]+/, 'This code returns a value to its caller; the expression on this line identifies the returned data.'],
  ];
  const foundRules = new Set<number>();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(\/\/|\*|#)/u.test(line)) continue;
    rules.forEach(([pattern, explanation], rule) => { if (!foundRules.has(rule) && pattern.test(line)) { foundRules.add(rule); observations.push({ line: index + 1, text: line.trim().slice(0, 260), explanation }); } });
  }
  const dependencies = Array.from(new Set(Array.from(text.matchAll(/(?:\bfrom\s+|\bimport\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]|^\s*(?:import|using|#include)\s+([\w.<>/]+)/gm), match => match[1] || match[2]))).slice(0, 80);
  const functions: ResultDescription['functions'] = [];
  const declaration = /(?:\bfunction\s+([\w$]+)\s*\(([^)]*)\)|\b(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>|\bdef\s+([\w]+)\s*\(([^)]*)\)|\b(?:public|private|protected|static|void|int|char|bool|long|float|double|undefined\d*|uint\d*|String)\s+(?:[\w<>\[\]*]+\s+)*([\w]+)\s*\(([^;{}]*)\)\s*\{)/g;
  for (const match of text.matchAll(declaration)) {
    const name = match[1] || match[3] || match[5] || match[7]; const params = match[2] ?? match[4] ?? match[6] ?? match[8] ?? '';
    const line = text.slice(0, match.index).split('\n').length;
    const excerpt = routineBody(text, match.index!, match[0]); const body = excerpt.text;
    const calls = Array.from(new Set(Array.from(body.matchAll(/\b([\w$]+(?:\.[\w$]+)*)\s*\(/g), item => item[1]).filter(item => !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(item)))).slice(0, 8);
    const returned = body.match(/\breturn\s+([^;\n}]+)/)?.[1]?.trim().slice(0, 180);
    const plainReturn = returned?.replace(/\s*\+\s*/g, ' plus ').replace(/\s*\*\s*/g, ' multiplied by ').replace(/\s*===?\s*/g, ' equals ');
    functions.push({ name, line, explanation: `${name} is a declared routine${params.trim() ? ` that accepts ${params.trim().slice(0, 200)}` : ' with no named input parameters'}.${returned ? ` Its code returns ${plainReturn}.` : ' A return value was not established in the inspected body.'}${calls.length ? ` Its body references calls to ${calls.join(', ')}.` : ''}${/\bif\s*\(/.test(body) ? ' A condition selects at least one path through the body.' : ''}${/\b(for|while)\s*\(/.test(body) ? ' A loop repeats part of its work.' : ''}${/\b(throw|catch)\b/.test(body) ? ' It includes an error path or error handling.' : ''}${excerpt.complete ? ' These observations describe the recovered text; which paths run depends on its inputs and callers.' : ' The inspected body is incomplete or could not be structurally delimited, so further behavior may be missing.'}` });
    if (functions.length === 60) break;
  }
  if (functions.length === 60) limits.push('The description lists the first 60 recognized routine declarations. Other declarations may exist in the saved file.');
  const responsibilities = ['network communication calls', 'local file access', 'data storage', 'event handling', 'user interface operations', 'data encoding or decoding', 'cryptographic references', 'error handling', 'repeated processing', 'conditional behavior', 'returned values'];
  let purpose = observations.length ? `The inspected code includes ${Array.from(foundRules, rule => responsibilities[rule]).join(', ')}. The observations below point to the lines that show each responsibility. Its overall application purpose and the paths actually executed still depend on its callers, inputs and unresolved code.` : 'No specific application responsibility was established by the local text inspection. The file is retained in full so its contents can be inspected directly.';
  if (language === 'Source map') purpose = 'This file maps generated code locations to source locations. It helps connect recovered or bundled code to the source names and positions recorded by the build process; embedded source may also be present.';
  if (language === 'JSON') { try { const data = JSON.parse(text); purpose = `This file stores structured ${Array.isArray(data) ? `data containing ${data.length} top-level entries` : `data with top-level fields ${Object.keys(data ?? {}).slice(0, 20).join(', ') || '(none)'}`}. The field names describe the recorded structure; their values require inspection to determine the application meaning.`; } catch { limits.push('The sampled JSON could not be parsed as a complete document.'); } }
  return { analysisVersion: 1, summary: `${name} contains ${kind === 'pseudocode' ? 'reconstructed pseudocode' : language + ' text'} (${bytes.toLocaleString()} bytes). ${functions.length ? `${functions.length} routine declarations were recognized in the inspected text.` : 'No routine declarations were recognized by the local text inspection.'}`, purpose, observations, functions, dependencies, limitations: [...limits, 'Dependency names and code patterns are observations, not proof that a call is executed. Unresolved behavior remains unknown.'], language };
}

export class ResultsLibrary {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private dataDir: string, private filesystem: Filesystem = fs) {}
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.pending.then(work); this.pending = next.catch(() => {}); return next; }
  private get root() { return join(this.dataDir, 'results'); }
  private caseId(target: Target) { return digest(target.path); }
  private async index(caseId: string): Promise<ResultFile[]> {
    const files: ResultFile[] = [];
    try {
      const entries = await this.filesystem.readdir(join(this.root, caseId, 'files'), { withFileTypes: true });
      for (const item of entries) if (item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name)) {
        try { files.push(JSON.parse(await this.filesystem.readFile(join(this.root, caseId, 'files', item.name, 'metadata.json'), 'utf8'))); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    // Upgrade early local libraries without rewriting the catalogue for every file.
    try {
      const previous: ResultFile[] = JSON.parse(await this.filesystem.readFile(join(this.root, caseId, 'index.json'), 'utf8')).files;
      for (const file of previous) if (!files.some(item => item.id === file.id)) { await this.writeMetadata(file); files.push(file); }
      await this.filesystem.rm(join(this.root, caseId, 'index.json'));
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    return files;
  }
  private async writeMetadata(file: ResultFile) {
    this.filePath(file);
    const path = join(this.root, file.caseId, 'files', file.id, 'metadata.json'); const temp = `${path}.${randomUUID()}.tmp`;
    await this.filesystem.writeFile(temp, JSON.stringify(file, null, 2), { flag: 'wx', mode: 0o600 }); await this.filesystem.rename(temp, path);
  }
  async list(): Promise<ResultFile[]> { return this.serial(async () => (await this.listInternal()).map(file => ({ ...file, description: { ...file.description, observations: [], functions: [] } }))); }
  private async listInternal(): Promise<ResultFile[]> {
    let cases; try { cases = await this.filesystem.readdir(this.root, { withFileTypes: true }); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
    const all: ResultFile[] = [];
    for (const item of cases) if (item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name)) all.push(...await this.index(item.name));
    return all.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  async capture(input: Capture, extraRoots: string[] = []): Promise<{ saved: number; warnings: string[] }> {
    return this.serial(async () => {
      const caseId = this.caseId(input.target); const base = join(this.root, caseId);
      await this.filesystem.mkdir(base, { recursive: true, mode: 0o700 });
      const files = await this.index(caseId); const before = files.length; const warnings: string[] = [];
      const save = async (name: string, source: string, kind: ResultFile['kind'], bytes?: Buffer) => {
        const temporary = join(base, `${randomUUID()}.part`);
        const out = await this.filesystem.open(temporary, 'wx', 0o600); const hash = createHash('sha256'); let total = 0; const sample: Buffer[] = []; let sampled = 0;
        const consume = async (chunk: Buffer) => { hash.update(chunk); total += chunk.length; if (sampled < SAMPLE_BYTES) { const part = Buffer.from(chunk.subarray(0, SAMPLE_BYTES - sampled)); sample.push(part); sampled += part.length; } await out.writeFile(chunk); };
        let complete = false;
        try {
          if (bytes) await consume(bytes);
          else {
            const reader = await this.filesystem.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const before = await reader.stat(); if (!before.isFile()) throw new Error('Only regular files can be saved.');
              const buffer = Buffer.alloc(128 * 1024); let count;
              while ((count = (await reader.read(buffer, 0, buffer.length, null)).bytesRead)) await consume(buffer.subarray(0, count));
              const after = await reader.stat(); if (before.size !== total || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('File changed while being saved.');
            } finally { await reader.close(); }
          }
          complete = true;
        } finally { await out.close(); if (!complete) await this.filesystem.rm(temporary, { force: true }); }
        const sha256 = hash.digest('hex'); const id = digest(`${caseId}\0${source}\0${name}\0${sha256}`); const filename = safeName(name);
        const storedPath = join(base, 'files', id, 'content', filename);
        await this.filesystem.mkdir(join(base, 'files', id, 'content'), { recursive: true, mode: 0o700 });
        await this.filesystem.rename(temporary, storedPath);
        const existing = files.find(file => file.id === id);
        if (existing?.description.analysisVersion === 1) return;
        const preview = Buffer.concat(sample); const text = decodeText(preview, total > SAMPLE_BYTES);
        const description = describeResult(name, text, total, kind);
        const providerLimits = input.result.structuredContent?.limitations ?? input.result.structuredContent?.normalized_result?.limitations;
        if (Array.isArray(providerLimits)) description.limitations.push(...providerLimits.filter((text: unknown): text is string => typeof text === 'string'));
        const file: ResultFile = { id, caseId, name, filename, targetName: input.target.name, targetPath: input.target.path, sourcePath: source, storedPath, bytes: total, sha256, kind, savedAt: new Date().toISOString(), operation: input.operation, ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}), description };
        await this.filesystem.writeFile(join(base, 'files', id, 'description.json'), JSON.stringify(description, null, 2), { mode: 0o600 });
        if (existing) existing.description = description; else files.push(file);
        // Commit each file independently: interrupted recoveries keep earlier saved files.
        await this.writeMetadata(existing ?? file);
      };
      const roots = new Set(extraRoots); const visited = new Set<string>();
      const owned = await this.filesystem.realpath(this.dataDir);
      const resultsRoot = join(owned, 'results');
      const walkOutputs = (value: any, key = '', depth = 0) => {
        if (depth > 24 || value == null) return;
        // Admit a candidate only after resolving it below. macOS /var aliases and
        // Windows junctions must receive the same canonical containment check.
        if (typeof value === 'string' && /^(output_directory|output_root|output_path|output_file|decompiled_path|recovered_path|manifest_path|extraction_root|extraction_directory|extracted_path|published_path)$/i.test(key) && isAbsolute(value)) roots.add(value);
        if (Array.isArray(value)) value.forEach(item => walkOutputs(item, key, depth + 1)); else if (typeof value === 'object') Object.entries(value).forEach(([key, item]) => walkOutputs(item, key, depth + 1));
      };
      for (const [key, value] of Object.entries(input.arguments)) if (/^output_/.test(key)) walkOutputs(value, key);
      walkOutputs(input.result.structuredContent);
      const walkDirectory = async (path: string, root: string, depth = 0) => {
        if (depth > 64) throw new Error('Output nesting exceeds 64 levels; remaining files need a separate import.');
        const info = await this.filesystem.lstat(path); if (info.isSymbolicLink()) { warnings.push(`Skipped symbolic link: ${path}`); return; }
        const canonical = await this.filesystem.realpath(path); if (!within(root, canonical) || within(resultsRoot, canonical) || visited.has(canonical)) return;
        visited.add(canonical);
        if (info.isDirectory()) for (const item of await this.filesystem.readdir(canonical, { withFileTypes: true })) {
          try { await walkDirectory(join(canonical, item.name), root, depth + 1); } catch (error: any) { warnings.push(`${join(canonical, item.name)}: ${error.message}`); if (error.code === 'ENOSPC') break; }
        }
        else if (info.isFile()) await save(relative(root, canonical) || basename(canonical), canonical, 'recovered-file');
      };
      for (const root of roots) { try {
        const canonical = await this.filesystem.realpath(root);
        if (!extraRoots.includes(root) && (!within(owned, canonical) || canonical === owned)) throw new Error('Output path leaves its recovery scope.');
        await walkDirectory(canonical, canonical);
      } catch (error: any) { warnings.push(`${root}: ${error.message}`); } }
      let envelope = input.result.structuredContent;
      if (envelope === undefined) for (const item of input.result.content ?? []) if (item.type === 'text' && typeof item.text === 'string') { try { envelope = JSON.parse(item.text); } catch { if (/pseudo_code|decompile|assembly/.test(input.operation)) envelope = item.text; } break; }
      const payload = envelope?.normalized_result ?? envelope?.result ?? envelope;
      const inline = async (value: any, key = '', location = 'result', owner: any = undefined, depth = 0): Promise<void> => {
        if (depth > 24 || value == null) return;
        if (/^(error|errors)$/i.test(key) || value?.status === 'error') return;
        const pseudo = /^(pseudocode|pseudo_code|decompiled|decompiled_code|decompilation)$/i.test(key);
        const code = /^(source_code|source_text|javascript|decompiled_source)$/i.test(key) || (/^(source|code)$/i.test(key) && typeof value === 'string' && (/[\n{};=]/.test(value) || ['java', 'smali'].includes(owner?.representation)));
        const assembly = /^(assembly|disassembly|asm)$/i.test(key);
        const textResult = key === 'text' && (/decompile|source|read.*class/i.test(input.operation) || input.operation === 'import_managed_reconstruction');
        if (typeof value === 'string' && value.trim() && (pseudo || code || assembly || textResult || (key === '' && /pseudo_code|decompile|assembly/.test(input.operation)))) {
          const identity = owner?.procedure?.name ?? owner?.procedure?.entry_label ?? owner?.class_name ?? owner?.name ?? owner?.address ?? input.arguments.procedure ?? input.arguments.class_name ?? input.operation;
          const smali = owner?.representation === 'smali';
          const kind = pseudo || owner?.language === 'pseudocode' || /pseudo_code|decompile/.test(input.operation) && !code ? 'pseudocode' : assembly || /assembly/.test(input.operation) || smali || owner?.language === 'il' ? 'assembly' : 'source';
          const name = `${safeName(String(identity))}-${digest(location).slice(0, 8)}${owner?.language === 'csharp' ? '.cs' : owner?.language === 'il' ? '.il' : smali ? '.smali' : /android|class|jadx|jeb/.test(input.operation) ? '.java' : kind === 'assembly' ? '.asm' : kind === 'pseudocode' ? '.c' : '.js'}`;
          await save(name, `tool:${input.operation}:${location}`, kind, Buffer.from(value)); return;
        }
        if (Array.isArray(value)) { for (const [index, item] of value.entries()) await inline(item, key, `${location}[${index}]`, item, depth + 1); }
        else if (typeof value === 'object') for (const [childKey, item] of Object.entries(value)) await inline(item, childKey, `${location}.${childKey}`, value, depth + 1);
      };
      try { await inline(payload); } catch (error: any) { warnings.push(`Inline code: ${error.message}`); }
      return { saved: files.length - before, warnings };
    });
  }
  async read(id: string): Promise<{ file: ResultFile; text?: string; truncated: boolean }> {
    return this.serial(async () => {
      const file = (await this.listInternal()).find(file => file.id === id); if (!file) throw new Error('Saved result was not found.');
      const path = this.filePath(file); const handle = await this.filesystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const hash = createHash('sha256'); const samples: Buffer[] = []; const buffer = Buffer.alloc(128 * 1024); let total = 0; let sampled = 0; let count;
        while ((count = (await handle.read(buffer, 0, buffer.length, null)).bytesRead)) { const chunk = buffer.subarray(0, count); hash.update(chunk); total += count; if (sampled < 65536) { const sample = Buffer.from(chunk.subarray(0, 65536 - sampled)); samples.push(sample); sampled += sample.length; } }
        if (total !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error('Saved result failed its integrity check.');
        const bytes = Buffer.concat(samples); const text = decodeText(bytes, total > 65536);
        return { file, text, truncated: total > 65536 };
      } finally { await handle.close(); }
    });
  }
  private filePath(file: ResultFile) {
    if (!/^[a-f0-9]{64}$/.test(file.id) || !/^[a-f0-9]{64}$/.test(file.caseId) || safeName(file.filename) !== file.filename) throw new Error('Invalid saved result identity.');
    return join(this.root, file.caseId, 'files', file.id, 'content', file.filename);
  }
  async exportTo(directory: string, targetPath?: string): Promise<number> {
    return this.serial(async () => {
      const files = (await this.listInternal()).filter(file => !targetPath || file.targetPath === targetPath);
      await this.filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
      const manifest = []; const report = ['# REA Results', '', 'Saved recovered files and local static explanations. Inferences and coverage limits remain explicit.', ''];
      for (const file of files) {
        const destination = join(directory, file.id); await this.filesystem.mkdir(join(destination, 'files'), { recursive: true });
        const source = this.filePath(file); const output = join(destination, 'files', file.filename);
        await this.filesystem.copyFile(source, output);
        const reader = await this.filesystem.open(output, constants.O_RDONLY | constants.O_NOFOLLOW); const hash = createHash('sha256'); let total = 0;
        try { const buffer = Buffer.alloc(128 * 1024); let count; while ((count = (await reader.read(buffer, 0, buffer.length, null)).bytesRead)) { hash.update(buffer.subarray(0, count)); total += count; } } finally { await reader.close(); }
        if (hash.digest('hex') !== file.sha256 || total !== file.bytes) throw new Error(`Saved result failed its integrity check: ${file.name}`);
        const d = file.description;
        const markdown = [`# ${file.name}`, '', d.summary, '', '## Purpose and behavior', '', d.purpose, '', '## Observed behavior', '', ...d.observations.flatMap(item => [`- Line ${item.line}: ${item.explanation}`, `  Observed text: ${item.text}`]), '', '## Routines', '', ...d.functions.map(item => `- Line ${item.line}: ${item.explanation}`), '', '## Dependencies', '', ...(d.dependencies.length ? d.dependencies.map(name => `- ${name}`) : ['No dependency declarations were recognized in the inspected text.']), '', '## Provenance', '', `Target: ${file.targetPath}`, `Operation: ${file.operation}`, `Saved: ${file.savedAt}`, `SHA-256: ${file.sha256}`, '', '## Limits', '', ...d.limitations.map(text => `- ${text}`), ''].join('\n');
        await this.filesystem.writeFile(join(destination, 'description.md'), markdown, { mode: 0o600 });
        await this.filesystem.writeFile(join(destination, 'description.json'), JSON.stringify(d, null, 2), { mode: 0o600 });
        manifest.push({ ...file, storedPath: `${file.id}/files/${file.filename}` });
        report.push(`- [${file.name.replaceAll('[', '').replaceAll(']', '')}](${file.id}/files/${encodeURIComponent(file.filename)}) — [Plain-English description](${file.id}/description.md)`, `  ${d.summary}`, '');
      }
      await this.filesystem.writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, files: manifest }, null, 2), { mode: 0o600 });
      await this.filesystem.writeFile(join(directory, 'Results.md'), report.join('\n'), { mode: 0o600 });
      return files.length;
    });
  }
}
