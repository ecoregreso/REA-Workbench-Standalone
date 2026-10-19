import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ResultsLibrary, ReaEngine } from '../shared/dist/reaEngine.mjs';
const entryPath = fileURLToPath(new URL('../node_modules/rea-agents/scripts/rea.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('recovered tree persists exact bytes, descriptions, versions and portable exports across restarts', async () => {
 const work = await mkdtemp(join(tmpdir(), 'rea-results-')); const dataDir = join(work, 'profile'); const output = join(dataDir, 'outputs', 'recovery');
 await mkdir(join(output, 'modules'), { recursive: true });
 const code = 'import client from "api-client";\nexport function load(user) {\n if (!user) throw new Error("missing user");\n return fetch("https://example.test/users/" + user);\n}\n';
 await writeFile(join(output, 'modules', 'load.js'), code);
 const large = Buffer.from('export const value = "café";\n'.repeat(50000)); await writeFile(join(output, 'large.js'), large);
 const binary = Buffer.from([0, 255, 1, 2]); await writeFile(join(output, 'asset.bin'), binary);
 const originalDescription = '{"original":true}'; await writeFile(join(output, 'description.json'), originalDescription);
 const outside = join(work, 'outside.js'); await writeFile(outside, 'private outside contents');
 if (process.platform !== 'win32') await symlink(outside, join(output, 'escape.js'));
 const target = { id: 'session-one', path: join(work, 'app.exe'), name: 'app.exe', kind: 'file' };
 const input = { target, operation: 'recover_javascript_sources', arguments: { output_directory: output }, result: { structuredContent: { normalized_result: { output_directory: output }, limitations: ['Runtime equivalence is unknown.'] } } };
 const library = new ResultsLibrary(dataDir); const first = await library.capture(input);
 assert.equal(first.saved, 4); if (process.platform !== 'win32') assert.ok(first.warnings.some(warning => warning.includes('symbolic link')));
 assert.equal((await library.capture(input)).saved, 0);
 const restarted = new ResultsLibrary(dataDir); const files = await restarted.list(); assert.equal(files.length, 4);
 const file = files.find(file => file.name.endsWith('load.js')); assert.equal(file.sha256, sha(Buffer.from(code))); assert.equal((await restarted.read(file.id)).text, code);
 const description = (await restarted.read(file.id)).file.description;
 assert.ok(description.dependencies.includes('api-client')); assert.ok(description.observations.some(item => item.explanation.includes('network')));
 assert.ok(description.functions.some(item => item.name === 'load' && item.explanation.includes('fetch')));
 assert.ok(file.description.limitations.includes('Runtime equivalence is unknown.'));
 assert.equal(await readFile(files.find(file => file.filename === 'description.json').storedPath, 'utf8'), originalDescription, 'Generated descriptions never overwrite same-named recovered files');
 assert.equal((await restarted.read(files.find(file => file.filename === 'asset.bin').id)).text, undefined);
 assert.ok((await restarted.read(files.find(file => file.filename === 'large.js').id)).truncated);
 await writeFile(join(output, 'modules', 'load.js'), code + '\nexport const version = 2;'); assert.equal((await restarted.capture(input)).saved, 1);
 await rm(output, { recursive: true });
 assert.equal((await restarted.read(file.id)).text, code, 'Saved files are independent of provider temporary or output folders');
 const exported = join(work, 'portable'); assert.equal(await restarted.exportTo(exported, target.path), 5);
 const manifest = JSON.parse(await readFile(join(exported, 'manifest.json'), 'utf8'));
 for (const file of manifest.files) { assert.equal(sha(await readFile(join(exported, file.storedPath))), file.sha256); assert.ok((await readFile(join(exported, file.id, 'description.md'), 'utf8')).includes('Purpose and behavior')); }
 await writeFile(file.storedPath, 'tampered'); await assert.rejects(restarted.read(file.id), /integrity/); await assert.rejects(restarted.exportTo(join(work, 'bad-export')), /integrity/);
});

test('native batches, Android source and JEB text are saved independently with target isolation', async () => {
 const work = await mkdtemp(join(tmpdir(), 'rea-results-inline-')); const library = new ResultsLibrary(work);
 const a = { id: 'a', path: join(work, 'a.exe'), name: 'a.exe', kind: 'file' }; const b = { ...a, id: 'b', path: join(work, 'b.apk'), name: 'b.apk' };
 const result = { structuredContent: { normalized_result: { items: [{ status: 'ok', address: '0x100', procedure: { name: 'main' }, pseudocode: 'int main(int value) { return value + 11; }' }, { status: 'error', address: '0x200', error: 'Unavailable' }, { status: 'ok', address: '0x300', pseudocode: 'void save() { fwrite("a",1,1,fp); }' }] } } };
 assert.equal((await library.capture({ target: a, operation: 'batch_decompile', arguments: {}, result })).saved, 2);
 assert.equal((await library.capture({ target: a, operation: 'procedure_pseudo_code', arguments: { procedure: 'scalar' }, result: { structuredContent: { normalized_result: 'int scalar() { return 1; }' } } })).saved, 1);
 assert.equal((await library.capture({ target: b, operation: 'decompile_android_method', arguments: {}, result: { structuredContent: { normalized_result: { class_name: 'example.Client', representation: 'java', source: 'public int sum(int a, int b) { return a + b; }' } } } })).saved, 1);
 assert.equal((await library.capture({ target: b, operation: 'decompile_jeb_item', arguments: {}, result: { structuredContent: { normalized_result: { text: 'public void connect() { client.connect(); }' } } } })).saved, 1);
 assert.equal((await library.capture({ target: b, operation: 'decompile_android_method', arguments: {}, result: { structuredContent: { normalized_result: { representation: 'smali', source: '.method public static main()V\n return-void\n.end method' } } } })).saved, 1);
 const managed = { ...a, path: join(work, 'managed.dll'), name: 'managed.dll' };
 assert.equal((await library.capture({ target: managed, operation: 'import_managed_reconstruction', arguments: {}, result: { structuredContent: { limitations: ['Managed decompiler output is analyst inference.'], normalized_result: { methods: [{ reconstruction: { language: 'csharp', text: 'internal static int Calculate(int value) { return value + 1; }' } }, { reconstruction: { language: 'il', text: '.method public static int32 Calculate(int32) cil managed { ldarg.0 ret }' } }] } } } })).saved, 2);
 const files = await library.list(); assert.equal(files.length, 8); assert.ok(files.some(file => file.filename.endsWith('.smali')));
 assert.ok(files.some(file => file.filename.endsWith('.cs'))); assert.ok(files.some(file => file.filename.endsWith('.il')));
 assert.equal((await library.capture({ target: a, operation: 'inspect_native_metadata', arguments: {}, result: { structuredContent: { normalized_result: { source: 'ghidra-memory-block', code: 'provider_missing', errors: [{ pseudocode: 'not usable' }] } } } })).saved, 0, 'Provider labels and error fields are not presented as recovered code');
 assert.equal(await library.exportTo(join(work, 'only-a'), a.path), 3);
 assert.ok(JSON.parse(await readFile(join(work, 'only-a', 'manifest.json'), 'utf8')).files.every(file => file.targetPath === a.path));
 const secret = join(dirname(work), 'rea-outside-secret.js'); await writeFile(secret, 'not authorized');
 assert.equal((await library.capture({ target: a, operation: 'recover', arguments: {}, result: { structuredContent: { output_directory: dirname(work), source: { local_path: secret } } } })).saved, 0, 'Reported directories outside owned data are not acquired');
});

test('engine imports historical tool records and preserves the Results library through reset', async () => {
 const work = await mkdtemp(join(tmpdir(), 'rea-results-migrate-')); const dataDir = join(work, 'profile'); const journal = join(dataDir, 'records', 'old-session'); await mkdir(journal, { recursive: true });
 const target = { id: 'old-session', path: join(work, 'old.exe'), name: 'old.exe', kind: 'file' };
 await writeFile(join(journal, 'old-pseudocode.json'), JSON.stringify({ operation: 'procedure_pseudo_code', arguments: { procedure: 'main' }, result: { structuredContent: { subject: { local_path: target.path }, normalized_result: 'int main() { return 7; }' } } }));
 const engine = new ReaEngine({ entryPath, dataDir });
 try { const files = await engine.listResults(); assert.equal(files.length, 1); await engine.reset(); assert.equal((await engine.listResults()).length, 1); assert.ok((await engine.readResult(files[0].id)).text.includes('return 7')); }
 finally { await engine.dispose(); }
 const restarted = new ReaEngine({ entryPath, dataDir }); try { assert.equal((await restarted.listResults()).length, 1); const exported = await restarted.exportResults(); assert.equal(exported.count, 1); } finally { await restarted.dispose(); }
});

test('automatic output capture resolves host path aliases and cannot recursively import its own library', async () => {
 const work = await mkdtemp(join(tmpdir(), 'rea-results-alias-')); const physical = join(work, 'physical'); const alias = join(work, 'alias');
 await mkdir(physical); await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
 const output = join(alias, 'outputs', 'recovered'); await mkdir(output, { recursive: true }); await writeFile(join(output, 'main.js'), 'export function value() { return 11; }');
 const library = new ResultsLibrary(alias); const target = { id: 'alias', path: join(work, 'target.js'), name: 'target.js', kind: 'file' };
 assert.equal((await library.capture({ target, operation: 'recover', arguments: { output_directory: output }, result: {} })).saved, 1);
 assert.equal((await library.list()).length, 1);
 assert.equal((await library.capture({ target, operation: 'import', arguments: {}, result: {} }, [join(alias, 'results')])).saved, 0);
 assert.equal((await library.list()).length, 1);
});

test('target Results exports accept the original host alias after selection canonicalizes its path', async () => {
 const work = await mkdtemp(join(tmpdir(), 'rea-results-export-alias-')); const original = join(work, 'application'); const alias = join(work, 'application-alias');
 await mkdir(original); await writeFile(join(original, 'main.js'), 'export function result() { return 1; }'); await symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
 const engine = new ReaEngine({ entryPath, dataDir: join(work, 'profile') });
 try { await engine.selectTarget(alias, 'directory'); assert.equal((await engine.importResults(original)).saved, 1); assert.equal((await engine.exportResults({ targetPath: alias })).count, 1); }
 finally { await engine.dispose(); }
});
