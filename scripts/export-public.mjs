import {mkdtemp, mkdir, copyFile, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {publicSourceFiles} from './release-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = await publicSourceFiles(root);
const {version} = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const staging = await mkdtemp(path.join(tmpdir(), 'rea-public-source-'));
const release = path.join(root, 'release');
await mkdir(release, {recursive: true});
const output = path.join(release, `REA-Workbench-${version}-public-source.tar.gz`);
try {
  const folder = path.join(staging, 'REA-Workbench');
  for (const name of files) {
    const destination = path.join(folder, name);
    await mkdir(path.dirname(destination), {recursive: true});
    await copyFile(path.join(root, name), destination);
  }
  const result = spawnSync('tar', ['-czf', output, '-C', staging, 'REA-Workbench'], {shell: false, stdio: 'inherit'});
  if (result.error || result.status !== 0) throw new Error('Could not create public source archive.');
  const sha256 = createHash('sha256').update(await readFile(output)).digest('hex');
  await writeFile(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`);
  console.log(`Created ${output} (${files.length} files; no Git history, local profiles or draft license).`);
} finally { await rm(staging, {recursive: true, force: true}); }
