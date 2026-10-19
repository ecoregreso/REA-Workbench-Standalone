import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReaEngine } from '../shared/dist/reaEngine.mjs';

test('real REA session analyzes JavaScript, retains complete Evidence, enforces scope, and resets', { timeout: 180_000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'rea-workbench-proof-'));
  const targetPath = join(work, 'application'); const dataDir = join(work, 'data');
  await mkdir(targetPath);
  await writeFile(join(targetPath, 'package.json'), JSON.stringify({ name: 'proof-app', main: 'index.js', type: 'module' }));
  await writeFile(join(targetPath, 'index.js'), 'export function greeting(name) { return `Hello ${name}`; }\n');
  const engine = new ReaEngine({ entryPath: fileURLToPath(new URL('../node_modules/rea-agents/scripts/rea.mjs', import.meta.url)), dataDir, environment: { REA_EXAMPLE_API_KEY: 'secret-value-must-not-leak' } });
  try {
    const status = await engine.connect();
    assert.equal(status.connected, true); assert.equal(status.busy, false); assert.equal(status.version, '6.4.0'); assert.equal(status.toolCount, 170);
    assert.equal(status.tools.find(tool => tool.name === 'analyze_javascript_application')?.available, true);
    assert.equal(status.tools.find(tool => tool.name === 'analyze_function')?.available, false);
    assert.ok(!JSON.stringify(await engine.mcpConfig()).includes('secret-value-must-not-leak'));
    const target = await engine.selectTarget(targetPath, 'directory');
    const analysis = await engine.openTarget({ targetId: target.id });
    assert.equal(analysis.isError, undefined);
    assert.ok(analysis.structuredContent);
    const dossier = await engine.exportDossier();
    assert.ok(dossier.markdown.includes('analyze_javascript_application'));
    const complete = JSON.parse(await readFile(join(dirname(dossier.path), 'evidence.json'), 'utf8'));
    assert.ok(complete.records.length > 0);
    assert.ok(complete.records.some(record => record.operation === 'analyze_javascript_application'));
    const journal = await readdir(join(dirname(dossier.path), 'records'));
    assert.ok(journal.some(file => file.includes('analyze_javascript_application')));
    const callRecord = JSON.parse(await readFile(join(dirname(dossier.path), 'records', journal.find(file => file.includes('analyze_javascript_application'))), 'utf8'));
    assert.equal(callRecord.result.structuredContent.normalized_result.parent_evidence_id, analysis.structuredContent.normalized_result.parent_evidence_id);
    assert.ok(dossier.markdown.includes('](records/'));
    assert.ok(dossier.markdown.includes('[evidence.json](evidence.json)'));
    assert.ok(!dossier.markdown.includes(join(dataDir, 'records')), 'Dossier record links remain portable across machines');
    const outside = join(work, 'outside.txt'); await writeFile(outside, 'Outside the selected target.');
    await assert.rejects(engine.readArtifact(outside), /outside the selected target/u);
    await assert.rejects(engine.callTool({ name: 'export_evidence_bundle', arguments: { path: join(targetPath, 'index.js'), overwrite: true } }), /outputs must stay/u);
    assert.ok((await readFile(join(targetPath, 'index.js'), 'utf8')).startsWith('export function greeting'));
    await writeFile(join(dataDir, 'binary.bin'), Buffer.from([0, 1, 2]));
    await assert.rejects(engine.readArtifact(join(dataDir, 'binary.bin')), /Binary artifacts/u);
    if (process.platform !== 'win32') {
    const processPidFile = join(dataDir, 'captured-process.pid');
    const capture = engine.callTool({ name: 'capture_process_scenario', arguments: {
      executable: process.execPath, working_directory: targetPath,
      arguments: ['-e', 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', processPidFile], timeout_ms: 30_000,
    } });
    const captured = capture.then(value => ({ value }), error => ({ error }));
    let capturedPid;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { capturedPid = Number(await readFile(processPidFile, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(capturedPid, 'Owned runtime fixture reached its startup marker');
    await assert.rejects(engine.callTool({ name: 'binary_session', arguments: {} }), /busy/u);
    await engine.cancel();
    assert.ok((await captured).error, 'Cancel rejects the active request');
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(capturedPid, 0); await new Promise(resolve => setTimeout(resolve, 100)); } catch { capturedPid = undefined; break; }
    }
    assert.equal(capturedPid, undefined, 'Cancelled REA releases its owned runtime child');
    assert.equal((await engine.status()).connected, false);
    // Complete parent Evidence from before cancellation remains in the automatic snapshot.
    const afterCancel = await engine.exportDossier();
    assert.ok(afterCancel.markdown.includes('Completed-operation session snapshot'));
    }
    await engine.reset(); await engine.reset();
    const reset = await engine.status(); assert.equal(reset.connected, false); assert.equal(reset.target, undefined); assert.equal(reset.toolCount, 0);
    await assert.rejects(engine.exportDossier(), /Select and analyze/u);
    assert.ok((await stat(dossier.path)).isFile());
  } finally { await engine.dispose(); }
});
