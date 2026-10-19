import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {displayStartupArguments} from '../standalone/launchPolicy.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const executable = createRequire(import.meta.url)('electron');
const child = spawn(executable, [...displayStartupArguments({args}), path.join(root, 'standalone'), ...args], {
  shell: false, stdio: 'inherit', env: process.env,
});
child.once('error', error => { console.error(`REA Workbench could not start: ${error.message}`); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
