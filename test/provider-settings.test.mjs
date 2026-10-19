import test from 'node:test';
import assert from 'node:assert/strict';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReaEngine, providerSettingDefinitions } from '../shared/dist/reaEngine.mjs';

const entryPath = fileURLToPath(new URL('../node_modules/rea-agents/scripts/rea.mjs', import.meta.url));

test('provider paths persist canonically, clear to inherited baseline, and admit only known settings', async () => {
  const work = await filesystem.mkdtemp(join(tmpdir(), 'rea-provider-settings-'));
  const dataDir = join(work, 'profile'); const original = join(work, 'original-ghidra'); const replacement = join(work, 'selected-ghidra');
  await filesystem.mkdir(original); await filesystem.mkdir(replacement);
  const engine = new ReaEngine({ entryPath, dataDir, environment: { GHIDRA_INSTALL_DIR: original } });
  try {
    assert.equal(providerSettingDefinitions().length, 12);
    assert.equal((await engine.providerSettings()).find(item => item.id === 'ghidra').path, original);
    await assert.rejects(engine.configureProvider('REA_API_KEY', original), /Unknown provider/u);
    await assert.rejects(engine.configureProvider('ghidra', 5), /must be a string/u);
    const target = await engine.selectTarget(original);
    const saved = await engine.configureProvider('ghidra', replacement);
    assert.equal(saved.find(item => item.id === 'ghidra').overridden, true);
    assert.equal((await engine.status()).target.id, target.id, 'Provider changes preserve the selected target');
    assert.equal((await engine.status()).connected, false);
    const persistedPath = join(dataDir, 'provider-settings.json');
    const document = JSON.parse(await filesystem.readFile(persistedPath, 'utf8'));
    assert.deepEqual(document, { version: 1, paths: { ghidra: await filesystem.realpath(replacement) } });
    if (process.platform !== 'win32') assert.equal((await filesystem.stat(persistedPath)).mode & 0o777, 0o600);
    const restored = new ReaEngine({ entryPath, dataDir, environment: { GHIDRA_INSTALL_DIR: original } });
    try {
      assert.equal((await restored.providerSettings()).find(item => item.id === 'ghidra').path, await filesystem.realpath(replacement));
      const config = await restored.mcpConfig();
      assert.equal(config.configuration.mcpServers.rea.env.GHIDRA_INSTALL_DIR, await filesystem.realpath(replacement));
      const cleared = await restored.configureProvider('ghidra');
      assert.equal(cleared.find(item => item.id === 'ghidra').path, original);
      assert.equal(cleared.find(item => item.id === 'ghidra').overridden, false);
      assert.deepEqual(JSON.parse(await filesystem.readFile(persistedPath, 'utf8')).paths, {});
    } finally { await restored.dispose(); }
    const invalidJdk = join(work, 'jre'); await filesystem.mkdir(invalidJdk);
    await assert.rejects(engine.configureProvider('java', invalidJdk), /full Java JDK/u);
    const bundle = join(work, 'Example.jdk'); const home = join(bundle, 'Contents', 'Home');
    await filesystem.mkdir(join(home, 'bin'), { recursive: true });
    for (const executable of process.platform === 'win32' ? ['java.exe', 'javac.exe'] : ['java', 'javac']) await filesystem.writeFile(join(home, 'bin', executable), 'fixture');
    const java = (await engine.configureProvider('java', bundle)).find(item => item.id === 'java');
    assert.equal(java.path, await filesystem.realpath(home));
    const file = join(work, 'engine.jar'); await filesystem.writeFile(file, 'fixture');
    await engine.configureProvider('jadx', file);
    const unchosen = join(work, 'unchosen.jar'); await filesystem.writeFile(unchosen, 'outside');
    await assert.rejects(engine.readArtifact(unchosen), /outside/u);
    if (process.platform !== 'win32') {
      const alias = join(work, 'engine-link.jar'); await filesystem.symlink(file, alias);
      const setting = (await engine.configureProvider('jadx', alias)).find(item => item.id === 'jadx');
      assert.equal(setting.path, await filesystem.realpath(file));
      const escape = join(original, 'escape-link.txt'); await filesystem.symlink(unchosen, escape);
      await assert.rejects(engine.readArtifact(escape), /outside/u);
    }
  } finally { await engine.dispose(); }
});

test('invalid persisted environment keys are refused without reflecting their values', async () => {
  const dataDir = await filesystem.mkdtemp(join(tmpdir(), 'rea-invalid-settings-'));
  await filesystem.writeFile(join(dataDir, 'provider-settings.json'), JSON.stringify({ version: 1, paths: { REA_API_KEY: 'secret-sentinel' } }));
  const events = []; const engine = new ReaEngine({ entryPath, dataDir, eventSink: event => events.push(event) });
  try {
    const settings = await engine.providerSettings();
    assert.ok(settings.every(item => !item.overridden));
    assert.ok((await engine.status()).error.includes('rejected'));
    assert.ok(!JSON.stringify(events).includes('secret-sentinel'));
    assert.ok(!JSON.stringify(await engine.mcpConfig()).includes('secret-sentinel'));
    const directory = join(dataDir, 'ghidra'); await filesystem.mkdir(directory);
    await engine.configureProvider('ghidra', directory);
    assert.deepEqual(Object.keys(JSON.parse(await filesystem.readFile(join(dataDir, 'provider-settings.json'), 'utf8')).paths), ['ghidra']);
  } finally { await engine.dispose(); }
});

test('host raw filesystem adapter and owned runtime bootstrap preserve actual ASAR file identity', async () => {
  const work = await filesystem.mkdtemp(join(tmpdir(), 'rea-rawfs-')); const asar = join(work, 'fixture.asar');
  await filesystem.writeFile(asar, Buffer.from([1, 2, 3, 4]));
  let rawStatCalls = 0;
  const engine = new ReaEngine({ entryPath, dataDir: join(work, 'profile'), runtimeBootstrapPath: join(work, 'runtime.cjs'), filesystem: { ...filesystem, stat: async (...args) => { rawStatCalls++; return filesystem.stat(...args); } } });
  try {
    const target = await engine.selectTarget(asar);
    assert.equal(target.kind, 'file'); assert.equal(target.size, 4); assert.ok(rawStatCalls > 0);
    const config = await engine.mcpConfig();
    assert.deepEqual(config.configuration.mcpServers.rea.args, [join(work, 'runtime.cjs'), entryPath, 'mcp']);
  } finally { await engine.dispose(); }
});


test('selected Python virtual-environment executable keeps its invocation path', async () => {
  if (process.platform === 'win32') return;
  const work = await filesystem.mkdtemp(join(tmpdir(), 'rea-python-venv-'));
  const bin = join(work, 'venv', 'bin'); await filesystem.mkdir(bin, {recursive:true});
  const alias = join(bin, 'python3'); await filesystem.symlink(process.execPath, alias);
  const engine = new ReaEngine({entryPath, dataDir:join(work,'profile')});
  try {
    const selected = (await engine.configureProvider('pwntools', alias)).find(item=>item.id==='pwntools');
    assert.equal(selected.path, alias);
    assert.equal((await engine.mcpConfig()).configuration.mcpServers.rea.env.REA_PWNTOOLS_PYTHON, alias);
  } finally {await engine.dispose();}
});
