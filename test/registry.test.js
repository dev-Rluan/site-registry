import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Store, encrypt, decrypt, masterKey } from '../store.js';
import { createServer } from '../server.js';
import { handler } from '../mcp.js';

const key='test-key-32-characters-or-longer-123456';
const source={kind:'policy',title:'규칙',body:'같은 주문번호를 확인한다.',source:'가상 정책',shared:true};
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'site-registry-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const path=join(directory,'registry.sqlite'),store=new Store(path,key);t.after(()=>{try{store.close();}catch{}});return {directory,path,store};}
function site(store,slug='alpha'){return store.createSite({slug,name:slug,description:'가상 사이트'}).id;}
function approve(store,siteId,material){return store.reviewMaterial(siteId,material.id,{revision:material.revision,decision:'approved',reviewer:'사람 검토자',note:'가상 정책과 대조 확인'});}
test('AES-GCM encrypts with independent nonces and rejects wrong key, tampering and site mismatch',()=>{
  const value='{"apiToken":"private-value"}',a=encrypt(value,key,'site:1:config:1'),b=encrypt(value,key,'site:1:config:1');
  assert.notEqual(a,b);assert(!a.includes('private-value'));assert.equal(decrypt(a,key,'site:1:config:1'),value);
  assert.throws(()=>decrypt(a,'a-different-key-with-32-characters!!','site:1:config:1'));
  assert.throws(()=>decrypt(a,key,'site:2:config:1'));
  const changed=JSON.parse(a);changed.tag=Buffer.alloc(16).toString('base64');assert.throws(()=>decrypt(JSON.stringify(changed),key,'site:1:config:1'));
});
test('master key persists with private permissions; weak environment key is rejected',t=>{
  const {directory}=fixture(t),a=masterKey(directory);assert.equal(masterKey(directory),a);assert.equal(statSync(join(directory,'master.key')).mode&0o777,0o600);assert.throws(()=>masterKey(directory,'short'));
});
test('database config snapshots contain ciphertext, keep history and reject stale writes',t=>{
  const {store,path}=fixture(t),id=site(store);
  store.saveConfig(id,{base_revision:0,config:{apiToken:'SENSITIVE-SECRET-987654'}});
  store.saveConfig(id,{base_revision:1,config:{apiToken:'SECOND-SECRET-123456'}});
  assert.throws(()=>store.saveConfig(id,{base_revision:1,config:{}}),e=>e.status===409);
  assert.equal(store.configMeta(id).versions.length,2);assert(!JSON.stringify(store.detail(id)).includes('SENSITIVE-SECRET'));
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');assert(!readFileSync(path).includes(Buffer.from('SENSITIVE-SECRET-987654')));
  assert.throws(()=>new Store(path,'wrong-key-32-or-more-characters-123456'),/일치하지/);
});
test('site boundaries prevent editing another site material and isolate MCP context',t=>{
  const {store}=fixture(t),a=site(store),b=site(store,'beta');const m=store.saveMaterial(a,source);
  approve(store,a,m);approve(store,b,store.saveMaterial(b,{...source,body:'베타 전용 규칙'}));
  assert.throws(()=>store.saveMaterial(b,{...source,base_revision:1},m.id),e=>e.status===404);
  assert.equal(store.context('alpha').materials.length,1);assert(!JSON.stringify(store.context('alpha')).includes('베타 전용'));
});
test('material revisions preserve snapshots and only an approved shared version reaches MCP',t=>{
  const {store}=fixture(t),id=site(store),m=store.saveMaterial(id,source);
  assert.equal(store.context('alpha').materials.length,0);approve(store,id,m);
  const draft=store.saveMaterial(id,{...source,body:'새 규칙',shared:false,base_revision:1},m.id);
  const v=store.detail(id).materials[0].versions;assert.equal(v.length,2);assert.equal(v[1].body,source.body);
  assert.equal(store.context('alpha').materials[0].revision,1);approve(store,id,draft);
  assert.equal(store.context('alpha').materials.length,0);
  assert.throws(()=>store.saveMaterial(id,{...source,base_revision:1},m.id),e=>e.status===409);
  assert.throws(()=>store.saveMaterial(id,{...source,kind:'raw_data',body:'not json'}),/JSON/);
});
test('MCP initializes, binds a single site, excludes secrets and cannot approve or change settings',t=>{
  const {store}=fixture(t);store.seedDemo();const handle=handler(store,'demo-alpha');
  assert.equal(handle({jsonrpc:'2.0',id:1,method:'tools/list'}).error.code,-32000);
  const init=handle({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}});assert.equal(init.result.protocolVersion,'2025-11-25');
  assert.equal(handle({jsonrpc:'2.0',method:'notifications/initialized'}),null);
  const names=handle({jsonrpc:'2.0',id:3,method:'tools/list'}).result.tools.map(tool=>tool.name);
  assert.deepEqual(names.toSorted(),['get_feature_map','get_site_context','list_sites','record_analysis','save_evidence_draft'].toSorted());
  const context=handle({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_site_context',arguments:{}}});const value=JSON.parse(context.result.content[0].text);
  assert.equal(value.site.slug,'demo-alpha');assert(value.materials.length>=1);assert(!JSON.stringify(value).includes('DEMO-NOT-A-REAL-TOKEN'));assert(!JSON.stringify(value).includes('검토 중 메모'));assert(!JSON.stringify(value).includes('BETA-01'));
  assert.equal(handle({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'get_site_context',arguments:{slug:'demo-beta'}}}).error.code,-32602);
  assert.equal(handle({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'save_config'}}).error.code,-32602);
  assert.equal(handle({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'review_material',arguments:{decision:'approved'}}}).error.code,-32602);
});
test('stdio process completes real JSON-RPC exchange without loading the encryption key',t=>{
  const {store,directory}=fixture(t);store.seedDemo();store.close();const requests=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_site_context',arguments:{}}}];
  const output=execFileSync(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'..','mcp.js')],{input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',encoding:'utf8',timeout:5000,env:{...process.env,SITE_REGISTRY_DATA_DIR:directory,SITE_REGISTRY_SITE:'demo-alpha',SITE_REGISTRY_KEY:'',SITE_REGISTRY_DEMO:'0'}});
  const responses=output.trim().split('\n').map(JSON.parse);assert.equal(responses.length,3);assert.equal(responses[2].id,3);assert.equal(JSON.parse(responses[2].result.content[0].text).site.slug,'demo-alpha');assert(!output.includes('DEMO-NOT-A-REAL-TOKEN'));
});
test('HTTP flow registers site, saves config/material, reads public context and blocks cross-origin writes',async t=>{
  const {store}=fixture(t),server=createServer(store);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root=`http://127.0.0.1:${server.address().port}`;
  async function send(path,method='GET',data,headers={}){const response=await fetch(root+path,{method,headers:{...data?{'Content-Type':'application/json'}:{},...headers},body:data?JSON.stringify(data):undefined});return [response.status,await response.json()];}
  const [status,s]=await send('/api/sites','POST',{slug:'alpha',name:'알파'});assert.equal(status,201);
  assert.equal((await send(`/api/sites/${s.id}/config`,'PUT',{base_revision:0,config:{apiToken:'HTTP-SECRET-VALUE'}}))[0],200);
  const created=await send(`/api/sites/${s.id}/materials`,'POST',source);
  assert.equal((await send(`/api/sites/${s.id}/context`))[1].materials.length,0);
  assert.equal((await send(`/api/sites/${s.id}/materials/${created[1].id}/review`,'POST',{revision:1,decision:'approved',reviewer:'사람 검토자',note:'출처 확인'}))[0],201);
  const detail=await send(`/api/sites/${s.id}`);assert.equal(detail[1].config.revision,1);assert(!JSON.stringify(detail).includes('HTTP-SECRET-VALUE'));
  const context=await send(`/api/sites/${s.id}/context`);assert.equal(context[1].materials.length,1);assert(!JSON.stringify(context).includes('HTTP-SECRET-VALUE'));
  assert.equal((await send('/api/sites','POST',{slug:'blocked',name:'차단'},{Origin:'https://foreign.example'}))[0],403);
  assert.equal((await send('/api/sites','POST',{slug:'alpha',name:'중복'}))[0],409);
});
