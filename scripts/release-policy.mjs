import {readdir, readFile, lstat} from 'node:fs/promises';
import path from 'node:path';

// Keep retired host names out of public source and bundles, including this policy.
const retiredNames = [['cor', 'tex'], ['lia', 'ison']].map(parts => parts.join(''));
const rootFiles = new Set(['.gitignore', 'README.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json']);
const sourceRoots = new Set(['.github', 'build', 'docs', 'scripts', 'shared', 'standalone', 'test', 'ui']);
const localOnly = new Set(['.git', 'node_modules', 'release', 'shared/dist', 'standalone/dist', 'docs/license-draft.txt']);

export function assertPublicBytes(bytes, filename) {
  const text = bytes.toString('utf8').toLowerCase();
  if (retiredNames.some(name => text.includes(name) || filename.toLowerCase().includes(name))) {
    throw new Error(`Retired host reference in ${filename}`);
  }
  if (/\/(?:home|users)\/[^\s"'<>]+/i.test(text) || /[a-z]:\\users\\/i.test(text)) {
    throw new Error(`Personal absolute path in ${filename}`);
  }
  if (/-----begin (?:rsa |ec |openssh )?private key-----|\b(?:sk-proj-|ghp_|github_pat_)[a-z0-9_-]{16,}/i.test(text)) {
    throw new Error(`Credential material in ${filename}`);
  }
}

function permittedSource(relative) {
  if (rootFiles.has(relative)) return true;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(relative)) return true;
  if (/^build\/icon\.png$/.test(relative)) return true;
  if (/^docs\/(?:[^/]+\.md|images\/[^/]+\.png)$/.test(relative)) return true;
  if (/^scripts\/[^/]+\.mjs$/.test(relative)) return true;
  if (/^shared\/[^/]+\.(?:ts|cjs)$/.test(relative)) return true;
  if (/^standalone\/[^/]+\.(?:ts|tsx|cjs|mjs|html|json)$/.test(relative)) return true;
  if (/^standalone\/build\/[^/]+\.(?:cjs|plist|png)$/.test(relative)) return true;
  if (/^test\/[^/]+\.test\.mjs$/.test(relative)) return true;
  return /^ui\/[^/]+\.(?:ts|tsx|css)$/.test(relative);
}

export async function publicSourceFiles(root) {
  const files = [];
  async function walk(relative = '') {
    for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (localOnly.has(name)) continue;
      const info = await lstat(path.join(root, name));
      if (info.isSymbolicLink()) throw new Error(`Public source cannot contain links: ${name}`);
      if (info.isDirectory()) {
        if (!relative && !sourceRoots.has(name)) throw new Error(`Unexpected release directory: ${name}`);
        await walk(name);
      } else {
        if (!info.isFile() || !permittedSource(name)) throw new Error(`Unreviewed release file: ${name}`);
        assertPublicBytes(await readFile(path.join(root, name)), name);
        files.push(name);
      }
    }
  }
  await walk();
  return files.sort();
}

export async function checkDistribution(directory) {
  let count = 0;
  async function walk(folder) {
    for (const entry of await readdir(folder, {withFileTypes: true})) {
      const filename = path.join(folder, entry.name);
      const relative = path.relative(directory, filename);
      if (entry.isSymbolicLink()) throw new Error(`Distribution link: ${relative}`);
      if (entry.isDirectory()) { await walk(filename); continue; }
      if (!entry.isFile() || entry.name.endsWith('.map')) throw new Error(`Unexpected distribution file: ${relative}`);
      assertPublicBytes(await readFile(filename), relative);
      count++;
    }
  }
  await walk(directory);
  if (!count) throw new Error('Distribution is empty. Build the app first.');
  return count;
}
