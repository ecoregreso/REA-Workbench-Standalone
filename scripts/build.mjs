import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await rm(path.join(root,'standalone/dist'),{recursive:true,force:true});
await mkdir(path.join(root,'standalone/dist'),{recursive:true});
await build({entryPoints:[path.join(root,'standalone/main.ts')],bundle:true,platform:'node',target:'node24',format:'cjs',outfile:path.join(root,'standalone/dist/main.cjs'),external:['electron','@modelcontextprotocol/client','@modelcontextprotocol/client/*'], sourcemap:false});
await copyFile(path.join(root,'standalone/preload.cjs'),path.join(root,'standalone/dist/preload.cjs'));
await copyFile(path.join(root,'shared/runtime.cjs'),path.join(root,'standalone/dist/runtime.cjs'));
for (const name of ['README.md','THIRD_PARTY_NOTICES.md']) await copyFile(path.join(root,name),path.join(root,'standalone/dist',name));
// Remove an earlier build's project license before copying an optional current one.
await rm(path.join(root,'standalone/dist/LICENSE'), { force: true });
try { await copyFile(path.join(root,'LICENSE'),path.join(root,'standalone/dist/LICENSE')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await import('./build-shared.mjs');
await viteBuild({configFile:false,root:path.join(root,'standalone'),base:'./',build:{outDir:'dist/ui',emptyOutDir:true,sourcemap:false}, esbuild:{jsx:'automatic'}});
