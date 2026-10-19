import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ReaEngine, reaHostEnvironment } from '../shared/dist/reaEngine.mjs';
const entryPath = fileURLToPath(new URL('../node_modules/rea-agents/scripts/rea.mjs', import.meta.url));

test('target source records preserve actual UTF8 bytes/hash independently of REA Evidence and exclude report reads', async () => {
  const work = await mkdtemp(join(tmpdir(), 'rea-source-records-')); const targetPath = join(work, 'source'); const dataDir = join(work, 'profile');
  await mkdir(targetPath); const path = join(targetPath, 'index.js'); const text = '\uFEFFexport const source = "café";\r\n';
  const bytes = Buffer.from(text, 'utf8'); await writeFile(path, bytes);
  const canonicalPath = await realpath(path);
  let requestedPath = path;
  if (process.platform !== 'win32') {
    // Exercise the same alias-to-physical identity contract as /var on macOS and Windows short paths.
    const alias = join(work, 'source-alias'); await symlink(targetPath, alias, 'dir');
    requestedPath = join(alias, 'index.js');
  }
  const engine = new ReaEngine({ entryPath, dataDir });
  try {
    const target = await engine.selectTarget(targetPath);
    assert.deepEqual(await engine.readArtifact(requestedPath), { path: canonicalPath, text });
    const records = join(dataDir, 'records', target.id); const files = await readdir(records);
    assert.equal(files.length, 1);
    const captured = JSON.parse(await readFile(join(records, files[0]), 'utf8'));
    assert.equal(captured.operation, 'read_artifact'); assert.equal(captured.authority, 'workbench-static-bytes');
    assert.deepEqual(captured.result, { path: canonicalPath, text });
    assert.deepEqual(captured.source, { path: canonicalPath, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    assert.ok(!('evidence_id' in captured));
    const report = join(dataDir, 'example-dossier.md'); await writeFile(report, '# Previously exported report');
    assert.equal((await engine.readArtifact(report)).text, '# Previously exported report');
    assert.equal((await readdir(records)).length, 1, 'Reading an engine output does not recursively add records');
    assert.deepEqual(await readFile(path), bytes, 'Source journaling preserves original bytes');
  } finally { await engine.dispose(); }
});

test('Windows child environments retain case-insensitive runtime paths without importing unrelated credentials', () => {
  const baseline = { Path: 'C:\\Java\\bin;C:\\Windows', SystemRoot: 'C:\\Windows', Windir: 'C:\\Windows', ghidra_install_dir: 'C:\\Tools\\Ghidra', java_home: 'C:\\Java', unrelated_token: 'excluded-sentinel' };
  const windows = reaHostEnvironment(baseline, { path: 'D:\\ProviderBin', electron_run_as_node: '1' }, 'win32');
  assert.deepEqual(windows, { PATH: 'D:\\ProviderBin', SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(reaHostEnvironment({}, {java_home: 'C:\\Java'}, 'win32'), {JAVA_HOME: 'C:\\Java'}, 'Provider settings require explicit host configuration');
  assert.ok(!JSON.stringify(windows).includes('excluded-sentinel'));
  assert.deepEqual(reaHostEnvironment(baseline, {}, 'linux'), {}, 'POSIX environment keys retain case sensitivity');
});
