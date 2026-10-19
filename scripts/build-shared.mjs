import {build} from 'esbuild';
import {mkdir,copyFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await rm(path.join(root,'shared/dist'),{recursive:true,force:true});
await mkdir(path.join(root,'shared/dist'),{recursive:true});
await copyFile(path.join(root,'shared/runtime.cjs'),path.join(root,'shared/dist/runtime.cjs'));
for(const name of ['reaEngine','electron']) await build({entryPoints:[path.join(root,`shared/${name}.ts`)],bundle:true,platform:'node',target:'node22',format:'esm',outfile:path.join(root,`shared/dist/${name}.mjs`),external:['electron','@modelcontextprotocol/client','@modelcontextprotocol/client/*'],sourcemap:false});
