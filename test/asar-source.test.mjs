import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as filesystem from 'node:fs/promises';
import { ReaEngine } from '../shared/dist/reaEngine.mjs';
const { createPackageWithOptions } = createRequire(import.meta.url)('@electron/asar');
const entryPath = fileURLToPath(new URL('../node_modules/rea-agents/scripts/rea.mjs', import.meta.url));

test('official Electron ASAR source preview reads exact inert members and rejects unsafe or modified data', async () => {
  const work = await mkdtemp(join(tmpdir(), 'rea-asar-source-')); const source = join(work, 'source'); const carrier = join(work, 'app.asar');
  await mkdir(source); await mkdir(join(source, 'lib'));
  const code = 'export const greeting = name => `Hello ${name}`;\n';
  await writeFile(join(source, 'lib', 'greet.js'), code);
  await writeFile(join(source, 'unpacked.txt'), 'Original unpacked source.');
  await writeFile(join(source, 'binary.bin'), Buffer.from([1, 0, 2]));
  await writeFile(join(source, 'large.txt'), 'X'.repeat(2 * 1024 * 1024 + 1));
  if (process.platform !== 'win32') await symlink(join(source, 'lib', 'greet.js'), join(source, 'alias.js'));
  await createPackageWithOptions(source, carrier, { unpack: 'unpacked.txt' });
  const before = await readFile(carrier);
  const engine = new ReaEngine({ entryPath, dataDir: join(work, 'profile') });
  try {
    await engine.selectTarget(carrier, 'file');
    const observed = await engine.readArtifact(`${carrier}/lib/greet.js`);
    assert.equal(observed.text, code);
    assert.equal((await engine.readArtifact(`${carrier}/unpacked.txt`)).text, 'Original unpacked source.');
    await assert.rejects(engine.readArtifact(`${carrier}/../outside.txt`), /Unsafe ASAR/u);
    await assert.rejects(engine.readArtifact(`${carrier}/binary.bin`), /Binary ASAR/u);
    await assert.rejects(engine.readArtifact(`${carrier}/large.txt`), /2 MiB/u);
    await assert.rejects(engine.readArtifact(`${carrier}/absent.js`), /absent/u);
    if (process.platform !== 'win32') await assert.rejects(engine.readArtifact(`${carrier}/alias.js`), /not a regular file/u);
    assert.deepEqual(await readFile(carrier), before, 'Source preview preserves the carrier bytes');
    await writeFile(join(`${carrier}.unpacked`, 'unpacked.txt'), 'Changed unpacked source.');
    await assert.rejects(engine.readArtifact(`${carrier}/unpacked.txt`), /integrity|declared size/u);
    if (process.platform !== 'win32') {
      const { unlink } = await import('node:fs/promises');
      await unlink(join(`${carrier}.unpacked`, 'unpacked.txt'));
      const outside = join(work, 'outside.txt'); await writeFile(outside, 'Original unpacked source.');
      await symlink(outside, join(`${carrier}.unpacked`, 'unpacked.txt'));
      await assert.rejects(engine.readArtifact(`${carrier}/unpacked.txt`), /escaped|link/u);
    }
  } finally { await engine.dispose(); }
});

test('ASAR preview validates metadata extents before allocating or reading a member', async () => {
  const work = await mkdtemp(join(tmpdir(), 'rea-asar-malformed-')); const carrier = join(work, 'malformed.asar');
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(1024 * 1024 * 512, 4); prefix.writeUInt32LE(4, 8);
  await writeFile(carrier, prefix);
  const engine = new ReaEngine({ entryPath, dataDir: join(work, 'profile') });
  try {
    await engine.selectTarget(carrier);
    await assert.rejects(engine.readArtifact(`${carrier}/index.js`), /invalid pickle extents/u);
    const header = Buffer.from(JSON.stringify({ files: { 'index.js': { size: 1, offset: '999999999999999999' } } }));
    const padding = (4 - header.length % 4) % 4; const headerSize = 8 + header.length + padding;
    const validPrefix = Buffer.alloc(16); validPrefix.writeUInt32LE(4, 0); validPrefix.writeUInt32LE(headerSize, 4); validPrefix.writeUInt32LE(headerSize - 4, 8); validPrefix.writeUInt32LE(header.length, 12);
    await writeFile(carrier, Buffer.concat([validPrefix, header, Buffer.alloc(padding), Buffer.from('x')]));
    await assert.rejects(engine.readArtifact(`${carrier}/index.js`), /range leaves/u);
  } finally { await engine.dispose(); }
});

test('pending ASAR source reads cannot return into a reset project scope', async () => {
  const work = await mkdtemp(join(tmpdir(), 'rea-asar-scope-')); const source = join(work, 'source'); const carrier = join(work, 'app.asar');
  await mkdir(source); await writeFile(join(source, 'index.js'), 'export const original = true;');
  await createPackageWithOptions(source, carrier, {});
  let start; const started = new Promise(resolve => { start = resolve; });
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  const rawFilesystem = { ...filesystem, open: async (...args) => {
    const handle = await filesystem.open(...args);
    return new Proxy(handle, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'read') return async (...readArgs) => { start(); await gate; return target.read(...readArgs); };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const engine = new ReaEngine({ entryPath, dataDir: join(work, 'profile'), filesystem: rawFilesystem });
  try {
    await engine.selectTarget(work, 'directory');
    const pending = engine.readArtifact(`${carrier}/index.js`);
    const rejected = assert.rejects(pending, /target changed/u);
    await started; await engine.reset(); resume(); await rejected;
    assert.equal((await engine.status()).target, undefined);
  } finally { resume(); await engine.dispose(); }
});
