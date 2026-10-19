import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ReaEngine,automaticJavaScriptHeapMb} from '../shared/dist/reaEngine.mjs';
const entryPath=fileURLToPath(new URL('../node_modules/rea-agents/scripts/rea.mjs',import.meta.url));

test('selected script inspection retains exact bytes, excludes siblings, exports sources and clears extra input grants', {timeout:180000}, async()=>{
 const work=await mkdtemp(join(tmpdir(),'rea-script-proof-'));
 const source=join(work,'only.js'); const sibling=join(work,'unselected.js');
 const bytes=Buffer.from('export function selected(value) { return value + 11; }\n');
 await writeFile(source,bytes);await writeFile(sibling,'throw new Error("must not execute or analyze sibling");');
 let dataDir=join(work,'profile');
 if(process.platform!=='win32'){
  await mkdir(dataDir);const alias=join(work,'profile-alias');await symlink(dataDir,alias);dataDir=alias;
 }
 const engine=new ReaEngine({entryPath,dataDir});
 try {
  const target=await engine.selectTarget(source);
  const result=await engine.openTarget({targetId:target.id});
  assert.ok(!result.isError);assert.equal(result.meta.operation,'analyze_javascript_application');
  assert.equal(result.meta.source.scope,'selected-file-only');
  assert.equal(result.meta.source.sha256,createHash('sha256').update(bytes).digest('hex'));
  const staged=dirname(result.meta.source.stagedPath);
  assert.deepEqual((await readdir(staged)).sort(),['only.js','package.json','workbench-source-provenance.json']);
  assert.deepEqual(await readFile(source),bytes);
  assert.equal(result.structuredContent.normalized_result.summary.statistics.parsed_javascript_files,1);
  await assert.rejects(engine.readArtifact(sibling),/outside/);
  const preview=await engine.readArtifact(result.meta.source.stagedPath);
  assert.equal(preview.text,bytes.toString('utf8'));
  const dossier=await engine.exportDossier();
  assert.deepEqual(await readFile(join(dirname(dossier.path),'sources','1','only.js')),bytes);
  assert.ok(dossier.markdown.includes('](sources/1/only.js)'));
  const records=await readdir(join(dirname(dossier.path),'records'));
  const record=JSON.parse(await readFile(join(dirname(dossier.path),'records',records.find(p=>p.includes('analyze_javascript_application'))),'utf8'));
  assert.equal(record.result.meta.source.sha256,result.meta.source.sha256);
  const staticRead=JSON.parse(await readFile(join(dirname(dossier.path),'records',records.find(p=>p.includes('read_artifact'))),'utf8'));
  assert.equal(staticRead.authority,'workbench-static-bytes');
  assert.equal(staticRead.source.path,target.path);
  assert.equal(staticRead.source.sha256,result.meta.source.sha256);
  await assert.rejects(engine.authorizeToolInput('export_evidence_bundle','path',sibling,'file'),/not an advertised local input/);
  await assert.rejects(engine.authorizeToolInput('binary_session','arbitrary',sibling,'file'),/not an advertised local input/);
  await engine.authorizeToolInput('compare_javascript_export_shapes','right_module_path',sibling,'file');
  assert.ok((await engine.readArtifact(sibling)).text.includes('must not execute'));
  await assert.rejects(engine.callTool({name:'export_evidence_bundle',arguments:{path:sibling,overwrite:true}}),/outputs must stay/);
  await writeFile(result.meta.source.stagedPath,'tampered');
  await assert.rejects(engine.exportDossier(),/snapshot changed/);
  await engine.reset();await assert.rejects(engine.readArtifact(sibling),/outside/);
 }finally{await engine.dispose();}
});


test('automatic JavaScript memory reserves host capacity and remains bounded',()=>{
 assert.equal(automaticJavaScriptHeapMb(512*1024*1024),128);
 assert.equal(automaticJavaScriptHeapMb(4*1024**3),1024);
 assert.equal(automaticJavaScriptHeapMb(16*1024**3),4096);
 assert.equal(automaticJavaScriptHeapMb(64*1024**3),4096);
});
