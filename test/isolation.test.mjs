import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ReaEngine, reaHostEnvironment} from '../shared/dist/reaEngine.mjs';
import {standaloneProfile, developmentOrigin, allowsRendererRequest} from '../standalone/isolationPolicy.mjs';
import {assertPublicBytes, publicSourceFiles} from '../scripts/release-policy.mjs';

test('packaged startup ignores development origins and foreign profiles', () => {
  const appData = path.join(tmpdir(), 'applications');
  const environment = {REA_WORKBENCH_USER_DATA: path.join(tmpdir(), 'other-profile'), REA_WORKBENCH_DEV_URL: 'http://127.0.0.1:9999'};
  assert.equal(standaloneProfile({appData, isPackaged: true, environment}), path.join(appData, 'REA Workbench'));
  assert.equal(developmentOrigin({isPackaged: true, environment}), undefined);
  assert.equal(standaloneProfile({appData, isPackaged: false, environment}), environment.REA_WORKBENCH_USER_DATA);
  assert.equal(developmentOrigin({isPackaged: false, environment}), environment.REA_WORKBENCH_DEV_URL);
  for (const value of ['https://127.0.0.1:9999', 'http://localhost:9999', 'http://127.0.0.1:9999/foreign-app', 'http://secret@127.0.0.1:9999', 'http://127.0.0.1']) {
    assert.throws(() => developmentOrigin({isPackaged: false, environment: {REA_WORKBENCH_DEV_URL: value}}));
  }
});

test('renderer requests stay in bundled assets or the exact development origin', () => {
  const uiDirectory = path.resolve('/app/dist/ui');
  const options = {uiDirectory};
  assert.equal(allowsRendererRequest(pathToFileURL(path.join(uiDirectory, 'index.html')).href, options), true);
  assert.equal(allowsRendererRequest(pathToFileURL(path.resolve('/private/profile.json')).href, options), false);
  for (const value of ['http://127.0.0.1:9999/collect', 'https://example.test/upload', 'ws://127.0.0.1:9999', 'file://foreign-host/private', 'invalid']) {
    assert.equal(allowsRendererRequest(value, options), false, value);
  }
  const dev = {uiDirectory, devOrigin: 'http://127.0.0.1:5173'};
  assert.equal(allowsRendererRequest('http://127.0.0.1:5173/renderer.tsx', dev), true);
  assert.equal(allowsRendererRequest('ws://127.0.0.1:5173/', dev), true);
  assert.equal(allowsRendererRequest('http://127.0.0.1:5174/collect', dev), false);
  assert.equal(allowsRendererRequest('http://secret@127.0.0.1:5173/', dev), false);
  assert.equal(allowsRendererRequest(pathToFileURL(path.join(uiDirectory, 'index.html')).href, dev), false);
});

test('ambient provider registrations and credentials are not inherited', () => {
  const baseline = {PATH: '/usr/bin', HOME: '/foreign-home', REA_IDA_MCP_CONFIG: '/foreign-registration', REA_JEB_MCP_URL: 'http://127.0.0.1:9999', REA_UNKNOWN_TOKEN: 'secret', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require=foreign.js', HTTP_PROXY: 'http://127.0.0.1:9999', CODEX_HOME: '/agent', JAVA_HOME: '/foreign-java'};
  assert.deepEqual(reaHostEnvironment(baseline), {PATH: '/usr/bin'});
  assert.deepEqual(reaHostEnvironment({Path: 'C:\\bin', SystemRoot: 'C:\\Windows', rea_unknown: 'secret'}, {}, 'win32'), {PATH: 'C:\\bin', SYSTEMROOT: 'C:\\Windows'});
});

test('actual engine child sees only its own home and explicitly configured providers', {timeout: 30000}, async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'rea-child-isolation-'));
  const entryPath = path.join(work, 'probe.mjs');
  await writeFile(entryPath, 'process.stdout.write(JSON.stringify({environment: process.env, cwd: process.cwd()}));');
  const dataDir = path.join(work, 'profile');
  const engine = new ReaEngine({entryPath, dataDir, environment: {REA_LOG_LEVEL: 'debug'}});
  try {
    const result = await engine.doctor();
    const env = result.environment;
    assert.equal(result.cwd, dataDir);
    assert.equal(env.HOME, path.join(dataDir, 'engine-home'));
    assert.equal(env.USERPROFILE, env.HOME);
    assert.equal(env.XDG_CONFIG_HOME, path.join(env.HOME, '.config'));
    assert.equal(env.APPDATA, path.join(env.HOME, 'AppData', 'Roaming'));
    assert.equal(env.TMPDIR, path.join(dataDir, 'tmp'));
    assert.equal(env.REA_LOG_LEVEL, 'error');
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.CODEX_HOME, undefined);
    assert.equal(env.REA_IDA_MCP_CONFIG, undefined);
    const config = await engine.mcpConfig();
    assert.equal(config.transport, 'stdio');
    assert.equal(config.configuration.mcpServers.rea.env.REA_IDA_MCP_CONFIG, undefined);
  } finally { await engine.dispose(); }
});

test('release policy rejects retired host references, private files, links and credentials', async () => {
  const retired = ['cor', 'tex'].join('');
  assert.throws(() => assertPublicBytes(Buffer.from(retired.toUpperCase()), 'fixture.txt'), /Retired host/);
  assert.throws(() => assertPublicBytes(Buffer.from('x'), `${retired}-adapter.js`), /Retired host/);
  assert.throws(() => assertPublicBytes(Buffer.from('/' + 'home/private/project'), 'fixture.txt'), /Personal absolute path/);
  assert.throws(() => assertPublicBytes(Buffer.from('-----BEGIN ' + 'PRIVATE KEY-----'), 'fixture.txt'), /Credential/);
  const work = await mkdtemp(path.join(tmpdir(), 'rea-release-policy-'));
  await writeFile(path.join(work, 'README.md'), 'public');
  assert.deepEqual(await publicSourceFiles(work), ['README.md']);
  await writeFile(path.join(work, '.env'), 'private');
  await assert.rejects(publicSourceFiles(work), /Unreviewed release file/);
});
