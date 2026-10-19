import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import {createRequire} from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import './build.mjs';
import {displayStartupArguments} from '../standalone/launchPolicy.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server=await createServer({configFile:false,root:path.join(root,'standalone'),server:{host:'127.0.0.1',port:0},esbuild:{jsx:'automatic'}});
await server.listen();
const address=server.httpServer.address();
const electronPath=createRequire(import.meta.url)('electron');
const args=process.argv.slice(2);
const electron=spawn(electronPath,[...displayStartupArguments({args}),path.join(root,'standalone'),...args],{shell:false,stdio:'inherit',env:{...process.env,REA_WORKBENCH_DEV_URL:`http://127.0.0.1:${address.port}`}});
let closing=false;
async function close(){if(closing)return;closing=true;electron.kill('SIGTERM');await server.close();}
electron.once('exit',(code,signal)=>{process.exitCode=code??(signal==='SIGINT'?130:1);void close();});
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>void close());
