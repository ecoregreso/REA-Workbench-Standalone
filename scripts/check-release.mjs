import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {publicSourceFiles, checkDistribution} from './release-policy.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = await publicSourceFiles(root);
const count = await checkDistribution(path.join(root, 'standalone/dist'));
console.log(`Release contents passed: ${files.length} public source files and ${count} application files.`);
