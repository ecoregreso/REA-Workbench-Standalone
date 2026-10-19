import {mkdtemp,mkdir,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {ReaEngine} from '../shared/dist/reaEngine.mjs';
import {checkDistribution} from './release-policy.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const release=path.join(root,'release');
let executable,app;
if(process.platform==='darwin'){
  let bundle;
  for(const name of await readdir(release)){
    const folder=path.join(release,name);
    if(!(await stat(folder)).isDirectory())continue;
    const names=await readdir(folder);
    const found=names.find(item=>item.endsWith('.app'));
    if(found){bundle=path.join(folder,found);break;}
  }
  if(!bundle)throw new Error('No packaged macOS app found.');
  const info=await readFile(path.join(bundle,'Contents/Info.plist'),'utf8');
  const name=/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/u.exec(info)?.[1];
  if(!name)throw new Error('Cannot find packaged macOS executable.');
  executable=path.join(bundle,'Contents/MacOS',name);
  app=path.join(bundle,'Contents/Resources/app');
}else{
  const prefix=process.platform==='win32'?'win':'linux';
  const folder=(await readdir(release)).find(name=>name.startsWith(prefix)&&name.endsWith('unpacked'));
  if(!folder)throw new Error(`No packaged ${prefix} app found.`);
  executable=path.join(release,folder,'rea-workbench'+(process.platform==='win32'?'.exe':''));
  app=path.join(release,folder,'resources/app');
}
const work=await mkdtemp(path.join(tmpdir(),'rea-packaged-smoke-'));
await checkDistribution(path.join(app, 'dist'));
const target=path.join(work,'target');await mkdir(target);
await writeFile(path.join(target,'package.json'),JSON.stringify({name:'packaged-smoke',type:'module',main:'main.js'}));
await writeFile(path.join(target,'main.js'),'export function greeting() { return "packaged REA"; }\n');
const engine=new ReaEngine({entryPath:path.join(app,'node_modules/rea-agents/scripts/rea.mjs'),runtimePath:executable,runtimeBootstrapPath:path.join(app,'dist/runtime.cjs'),environment:{ELECTRON_RUN_AS_NODE:'1'},dataDir:path.join(work,'evidence')});
try{
 const connected=await engine.connect();assert.equal(connected.version,'6.4.0');assert.equal(connected.toolCount,170);
 const selected=await engine.selectTarget(target,'directory');const result=await engine.openTarget({targetId:selected.id});assert.ok(!result.isError,'Packaged JavaScript analysis failed');
 const report=await engine.exportDossier();assert.ok(report.markdown.includes('analyze_javascript_application'));
 const imported=await engine.importResults(target);assert.equal(imported.saved,2);assert.deepEqual(imported.warnings,[]);
 const files=await engine.listResults();assert.equal(files.length,2);const source=files.find(file=>file.filename==='main.js');assert.ok(source);
 const preview=await engine.readResult(source.id);assert.ok(preview.text.includes('packaged REA'));assert.ok(preview.file.description.functions.some(fn=>fn.name==='greeting'));
 const saved=await engine.exportResults({targetPath:target});assert.equal(saved.count,2);
 await engine.reset();assert.equal((await engine.listResults()).length,2);
 const evidence={platform:process.platform,arch:process.arch,executable,version:connected.version,toolCount:connected.toolCount,analysis:'passed',dossier:'passed',results:{import:'passed',description:'passed',preview:'passed',export:'passed',resetPersistence:'passed'},testedAt:new Date().toISOString()};
 await writeFile(path.join(release,`SMOKE-${process.platform}-${process.arch}.json`),JSON.stringify(evidence,null,2)+'\n');
 process.stdout.write(JSON.stringify(evidence,null,2)+'\n');
}finally{await engine.dispose();}
