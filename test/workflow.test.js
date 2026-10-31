import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store.js';
import { createServer } from '../server.js';

const key='workflow-test-master-key-32-characters-or-longer';
const policy={kind:'policy',title:'취소 기준',body:'이용 하루 전까지 취소할 수 있다.',source:'가상 업무 정책 v1',shared:true};
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'registry-workflow-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'registry.sqlite'),store=new Store(path,key);
  t.after(()=>{try{store.close();}catch{}});
  const site=store.createSite({slug:'alpha',name:'알파',description:'가상 검증 환경'}).id;
  return {directory,path,store,site};
}
function review(store,site,material,decision='approved'){
  return store.reviewMaterial(site,material.id,{revision:material.revision,decision,reviewer:'사람 검토자',note:'가상 원문과 대조'});
}
function analysis(evidence,extra={}){
  return {request:'당일 취소를 허용하려면 무엇을 검토해야 하나?',mode:'risk',result:'취소 기준과 정산 영향의 확인이 필요하다.',source:'테스트 에이전트의 가상 분석',evidence,...extra};
}
test('approval is revision-specific and immutable; drafts and rejection preserve the established baseline',t=>{
  const {store,site}=fixture(t),v1=store.saveMaterial(site,policy);
  assert.equal(store.context('alpha').materials.length,0);
  assert.throws(()=>store.reviewMaterial(site,v1.id,{revision:2,decision:'approved',reviewer:'검토자',note:''}),e=>e.status===409);
  review(store,site,v1);
  assert.throws(()=>review(store,site,v1,'rejected'),e=>e.status===409);
  const v2=store.saveMaterial(site,{...policy,body:'검토되지 않은 변경',base_revision:1},v1.id);
  assert.equal(store.context('alpha').materials[0].body,policy.body);
  review(store,site,v2,'rejected');
  assert.equal(store.context('alpha').materials[0].revision,1);
  const v3=store.saveMaterial(site,{...policy,body:'이용 이틀 전까지 취소할 수 있다.',base_revision:2},v1.id);
  review(store,site,v3);
  assert.equal(store.context('alpha').materials[0].revision,3);
  const detail=store.detail(site).materials.find(m=>m.id===v1.id);
  assert.equal(detail.approved_revision,3);
  assert.deepEqual(detail.versions.map(v=>v.status),['approved','rejected','approved']);
  const noSource=store.saveMaterial(site,{...policy,title:'출처 미정',source:''});
  assert.throws(()=>review(store,site,noSource),e=>e.status===400);
});
test('feature JSON stays inside its site and approved map omits draft nodes and their edges',t=>{
  const {store,site}=fixture(t);
  const other=store.createSite({slug:'beta',name:'베타'}).id;
  const approved=store.saveMaterial(site,policy);review(store,site,approved);
  const draft=store.saveMaterial(site,{...policy,title:'검토 중 정산 기준'});
  const foreign=store.saveMaterial(other,{...policy,title:'다른 사이트 기준'});
  const feature={kind:'feature',title:'예약 취소',body:JSON.stringify({summary:'예약 취소 기능',rules:['승인된 취소 기준을 따른다.'],related_ids:[approved.id,draft.id]}),source:'가상 코드 src/cancel.js',shared:true};
  for(const body of ['not-json',JSON.stringify({summary:'요약',rules:'문자열',related_ids:[]}),JSON.stringify({summary:'요약',rules:[],related_ids:[foreign.id]})]){
    assert.throws(()=>store.saveMaterial(site,{...feature,body}));
  }
  const created=store.saveMaterial(site,feature);
  assert(!store.featureMap(site).nodes.some(n=>n.id===created.id));
  review(store,site,created);
  const map=store.featureMap(site),nodeIds=new Set(map.nodes.map(n=>n.id));
  assert(nodeIds.has(created.id));assert(nodeIds.has(approved.id));assert(!nodeIds.has(draft.id));assert(!nodeIds.has(foreign.id));
  assert.equal(map.edges.length,1);
  for(const edge of map.edges){assert(nodeIds.has(edge.from));assert(nodeIds.has(edge.to));}
});
test('batch credentials are ciphertext at rest and no read model or context returns the secret',t=>{
  const {store,site,path}=fixture(t),secret='BATCH-PRIVATE-TOKEN-123456789';
  const created=store.createBatch(site,{code:'nightly-sync',name:'야간 동기화',description:'가상 배치',schedule:'매일 02:00',secrets:{token:secret}});
  assert(!JSON.stringify(created).includes(secret));
  const context=store.context('alpha');
  assert.equal(context.batches.length,1);assert.equal(context.batches[0].code,'nightly-sync');assert.equal(context.batches[0].has_secret,true);
  for(const value of [store.detail(site),context])assert(!JSON.stringify(value).includes(secret));
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert(!readFileSync(path).includes(Buffer.from(secret)));
  assert.throws(()=>store.createBatch(site,{code:'bad',name:'잘못된 배치',secrets:'plain-secret'}),e=>e.status===400);
});
test('analysis snapshots bind exact approved revisions, survive later edits, and reject unsafe evidence',t=>{
  const {store,site}=fixture(t),approved=store.saveMaterial(site,policy);review(store,site,approved);
  const draft=store.saveMaterial(site,{...policy,title:'승인되지 않은 기준'});
  const rejected=store.saveMaterial(site,{...policy,title:'반려한 기준'});review(store,site,rejected,'rejected');
  const foreignSite=store.createSite({slug:'beta',name:'베타'}).id;
  const foreign=store.saveMaterial(foreignSite,policy);review(store,foreignSite,foreign);
  for(const evidence of [[],[{material_id:draft.id,revision:1}],[{material_id:rejected.id,revision:1}],[{material_id:foreign.id,revision:1}],[{material_id:approved.id,revision:99}]]){
    assert.throws(()=>store.saveAnalysis(site,analysis(evidence)));
  }
  const evidence=[{material_id:approved.id,revision:1}];
  const saved=store.saveAnalysis(site,analysis(evidence));
  const v2=store.saveMaterial(site,{...policy,body:'수정된 최신 정책',source:'가상 업무 정책 v2',base_revision:1},approved.id);review(store,site,v2);
  const before=store.analyses(site).find(a=>a.id===saved.id);
  assert.equal(before.evidence[0].revision,1);assert.equal(before.evidence[0].body,policy.body);assert.equal(before.evidence[0].source,policy.source);
  store.saveAnalysis(site,analysis(evidence,{result:'이전 분석을 보완한 결과',base_revision:1}),saved.id);
  const after=store.analyses(site).find(a=>a.id===saved.id);
  assert.equal(after.revision,2);assert.equal(after.versions.length,2);
  assert.equal(after.versions[1].result,'취소 기준과 정산 영향의 확인이 필요하다.');
  assert.equal(after.versions[1].evidence[0].body,policy.body);
  assert.throws(()=>store.saveAnalysis(site,analysis(evidence,{base_revision:1}),saved.id),e=>e.status===409);
  assert.throws(()=>store.saveAnalysis(foreignSite,analysis([{material_id:foreign.id,revision:1}],{base_revision:2}),saved.id),e=>e.status===404);
});
test('existing v0.1 shared material migrates as a draft, never as human-approved evidence',t=>{
  const directory=mkdtempSync(join(tmpdir(),'registry-legacy-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'legacy.sqlite'),db=new DatabaseSync(path);
  db.exec(`CREATE TABLE sites(id INTEGER PRIMARY KEY,slug TEXT UNIQUE NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE materials(id INTEGER PRIMARY KEY,site_id INTEGER NOT NULL REFERENCES sites(id),kind TEXT NOT NULL);
    CREATE TABLE material_versions(material_id INTEGER NOT NULL REFERENCES materials(id),revision INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,source TEXT NOT NULL,shared INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(material_id,revision));
    INSERT INTO sites VALUES(1,'legacy','이전 사이트','','2026-01-01');
    INSERT INTO materials VALUES(1,1,'policy');
    INSERT INTO material_versions VALUES(1,1,'이전 기준','검토 기록 없는 자료','이전 출처',1,'2026-01-01');`);
  db.close();
  const store=new Store(path,key);t.after(()=>store.close());
  assert.equal(store.detail(1).materials[0].versions[0].status,'draft');
  assert.equal(store.context('legacy').materials.length,0);
});
test('HTTP supports draft → review → approved map → versioned analysis without exposing batch credentials',async t=>{
  const {store,site}=fixture(t),server=createServer(store);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root=`http://127.0.0.1:${server.address().port}`,base=`/api/sites/${site}`;
  async function send(path,method='GET',data){const response=await fetch(root+path,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});return {status:response.status,body:await response.json()};}
  const draft=await send(`${base}/materials`,'POST',policy);assert.equal(draft.status,201);
  assert.equal((await send(`${base}/context`)).body.materials.length,0);
  const reviewInput={revision:1,decision:'approved',reviewer:'검토자',note:'출처 확인'};
  assert.equal((await send(`${base}/materials/${draft.body.id}/review`,'POST',reviewInput)).status,201);
  assert.equal((await send(`${base}/materials/${draft.body.id}/review`,'POST',reviewInput)).status,409);
  assert.equal((await send(`${base}/feature-map`)).body.nodes.length,1);
  const batch=await send(`${base}/batches`,'POST',{code:'daily',name:'일간 배치',description:'',schedule:'매일',secrets:{token:'HTTP-BATCH-SECRET'}});assert.equal(batch.status,201);
  const created=await send(`${base}/analyses`,'POST',analysis([{material_id:draft.body.id,revision:1}]));assert.equal(created.status,201);
  assert.equal((await send(`${base}/analyses/${created.body.id}`,'PUT',analysis([{material_id:draft.body.id,revision:1}],{base_revision:1,result:'보완한 검토'}))).status,200);
  const listed=await send(base);assert.equal(listed.status,200);assert.equal(listed.body.analyses[0].versions.length,2);
  assert(!JSON.stringify((await send(`${base}/context`)).body).includes('HTTP-BATCH-SECRET'));
});
test('actual stdio MCP can submit drafts and analysis but cannot approve or override its bound site',t=>{
  const {store,site,directory}=fixture(t),approved=store.saveMaterial(site,policy);review(store,site,approved);store.close();
  const requests=[
    {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'workflow-test',version:'1'}}},
    {jsonrpc:'2.0',method:'notifications/initialized'},
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'save_evidence_draft',arguments:{kind:policy.kind,title:'AI가 작성한 초안',body:policy.body,source:policy.source}}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'record_analysis',arguments:analysis([{material_id:approved.id,revision:1}])}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_site_context',arguments:{slug:'beta'}}},
    {jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'review_material',arguments:{decision:'approved'}}},
    {jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'save_evidence_draft',arguments:{kind:policy.kind,title:'승인 우회 시도',body:policy.body,source:policy.source,status:'approved'}}},
    {jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'save_evidence_draft',arguments:{kind:policy.kind,title:'공유 상태 변경 시도',body:policy.body,source:policy.source,shared:false}}}
  ];
  const output=execFileSync(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'..','mcp.js')],{input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',encoding:'utf8',timeout:10000,env:{...process.env,SITE_REGISTRY_DATA_DIR:directory,SITE_REGISTRY_SITE:'alpha',SITE_REGISTRY_KEY:'',SITE_REGISTRY_DEMO:'0'}});
  const responses=output.trim().split('\n').map(JSON.parse);
  assert.equal(responses.length,7);assert.equal(responses[1].result.isError,false);assert.equal(responses[2].result.isError,false);
  assert.equal(responses[3].error.code,-32602);assert.equal(responses[4].error.code,-32602);
  assert.equal(responses[5].error.code,-32602);assert.equal(responses[6].error.code,-32602);
  const verify=new Store(join(directory,'registry.sqlite'),null);t.after(()=>verify.close());
  const aiDraft=verify.detail(site).materials.find(m=>m.title==='AI가 작성한 초안');
  assert(aiDraft);assert.equal(aiDraft.versions[0].status,'draft');
  assert(!verify.context('alpha').materials.some(m=>m.id===aiDraft.id));
  assert.equal(verify.analyses(site).length,1);
});
