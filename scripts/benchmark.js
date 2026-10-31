import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.js';
import { createServer } from '../server.js';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const repetitions=40,warmups=5,coldRuns=5;
const secret='SYNTHETIC-SECRET-DO-NOT-EXPOSE';
const foreign='OTHER-SITE-SYNTHETIC-MARKER';
const key='synthetic-benchmark-key-not-a-real-secret-32';
const round=value=>Number(value.toFixed(3));
function stats(samples){
  const sorted=[...samples].sort((a,b)=>a-b);
  return {samples:sorted.length,p50_ms:round(sorted[Math.ceil(sorted.length*.5)-1]),p95_ms:round(sorted[Math.ceil(sorted.length*.95)-1]),min_ms:round(sorted[0]),max_ms:round(sorted.at(-1))};
}
async function measure(action){
  for(let i=0;i<warmups;i++)await action();
  const elapsed=[];
  for(let i=0;i<repetitions;i++){const start=performance.now();await action();elapsed.push(performance.now()-start);}
  return stats(elapsed);
}
function bytes(value){return Buffer.byteLength(JSON.stringify(value));}
function checkContext(context,count){
  assert.equal(context.site.slug,'benchmark');
  assert.equal(context.materials.length,count*.7);
  assert(context.materials.every(m=>m.revision===1));
  const serialized=JSON.stringify(context);
  for(const marker of [secret,foreign,'UNAPPROVED-VERSION','PRIVATE-MATERIAL'])assert(!serialized.includes(marker),`Unexpected disclosure: ${marker}`);
}
function seed(store,count){
  const site=store.createSite({slug:'benchmark',name:'Synthetic benchmark',description:'No real company data'}).id;
  const other=store.createSite({slug:'other-site',name:'Other synthetic site'}).id;
  store.saveConfig(site,{base_revision:0,config:{token:secret}});
  store.createBatch(site,{code:'synthetic-batch',name:'Synthetic batch',secrets:{token:secret}});
  const f=store.saveMaterial(other,{kind:'policy',title:foreign,body:foreign,source:'synthetic:foreign',shared:true});
  store.reviewMaterial(other,f.id,{revision:1,decision:'approved',reviewer:'Synthetic reviewer',note:''});
  for(let i=0;i<count;i++){
    const shared=i%10>=2,approved=i%10!==2;
    const body=(shared?'Approved synthetic policy: ':'PRIVATE-MATERIAL: ')+`document ${i}; `+'A request requires policy and source verification. '.repeat(10);
    const input={kind:i%10===9?'criterion':'policy',title:`Synthetic material ${i}`,body,source:`synthetic:material/${i}/v1`,shared};
    const m=store.saveMaterial(site,input);
    if(approved)store.reviewMaterial(site,m.id,{revision:1,decision:'approved',reviewer:'Synthetic reviewer',note:''});
    store.saveMaterial(site,{...input,body:`UNAPPROVED-VERSION v2: ${body}`,source:`synthetic:material/${i}/v2`,base_revision:1},m.id);
    if(i%10===3)store.reviewMaterial(site,m.id,{revision:2,decision:'rejected',reviewer:'Synthetic reviewer',note:'Synthetic rejection'});
    store.saveMaterial(site,{...input,body:`UNAPPROVED-VERSION v3: ${body}`,source:`synthetic:material/${i}/v3`,base_revision:2},m.id);
  }
  return site;
}
function connect(directory){
  const started=performance.now();
  const child=spawn(process.execPath,[join(root,'mcp.js')],{stdio:['pipe','pipe','pipe'],env:{...process.env,SITE_REGISTRY_DATA_DIR:directory,SITE_REGISTRY_SITE:'benchmark',SITE_REGISTRY_DEMO:'0',SITE_REGISTRY_KEY:''}});
  const lines=createInterface({input:child.stdout}),pending=new Map();let nextId=1,stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const fail=error=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
  child.on('error',fail);
  child.on('exit',code=>fail(new Error(`MCP exited (${code}): ${stderr}`)));
  lines.on('line',line=>{
    let response;try{response=JSON.parse(line);}catch(error){fail(error);return;}
    const item=pending.get(response.id);if(!item)return;
    clearTimeout(item.timer);pending.delete(response.id);
    if(response.error)item.reject(new Error(JSON.stringify(response.error)));else item.resolve({response,wire_bytes:Buffer.byteLength(line)+1});
  });
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
    const id=nextId++,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`MCP timeout: ${method}`));},10000);
    pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');
  });
  return {started,rpc,child,async close(){
    if(child.exitCode!==null)return;
    await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');},1000);child.once('close',()=>{clearTimeout(timer);lines.close();resolve();});child.stdin.end();});
  }};
}
async function initialize(client){
  await client.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'runtime-benchmark',version:'1'}});
  client.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
}
async function mcpContext(client,count){
  const output=await client.rpc('tools/call',{name:'get_site_context',arguments:{}});
  assert.equal(output.response.result.isError,false);
  const context=JSON.parse(output.response.result.content[0].text);checkContext(context,count);
  return {context,wire_bytes:output.wire_bytes};
}
async function scenario(count){
  const directory=mkdtempSync(join(tmpdir(),'site-registry-benchmark-'));
  const store=new Store(join(directory,'registry.sqlite'),key);
  let server,client;
  try{
    const site=seed(store,count),context=store.context('benchmark');checkContext(context,count);
    const fields=v=>({id:v.id,kind:v.kind,revision:v.revision,title:v.title,body:v.body,source:v.source,created_at:v.created_at,reviewer:v.reviewer,reviewed_at:v.reviewed_at});
    const raw=store.materials(site).flatMap(m=>m.versions.map(v=>fields({...v,id:m.id,kind:m.kind})));
    const selected=context.materials.map(fields);
    assert.equal(raw.length,count*3);assert.equal(selected.length,count*.7);
    const rawBytes=bytes(raw),selectedBytes=bytes(selected);
    const rawSerialized=await measure(()=>JSON.stringify(raw));
    const selectedSerialized=await measure(()=>JSON.stringify(selected));
    const storeContext=await measure(()=>store.context('benchmark'));
    server=createServer(store);
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const url=`http://127.0.0.1:${server.address().port}/api/sites/${site}/context`;
    const httpRoundtrip=await measure(async()=>{
      const response=await fetch(url);assert.equal(response.status,200);checkContext(await response.json(),count);
    });
    const coldInit=[],coldFirstContext=[];
    for(let i=0;i<coldRuns;i++){
      client=connect(directory);await initialize(client);coldInit.push(performance.now()-client.started);
      await mcpContext(client,count);coldFirstContext.push(performance.now()-client.started);
      if(i<coldRuns-1){await client.close();client=null;}
    }
    const stdio=await measure(()=>mcpContext(client,count));
    const mcpOutput=await mcpContext(client,count);
    return {
      material_count:count,versions_per_material:3,total_same_site_versions:raw.length,approved_shared_count:selected.length,
      payload:{same_field_raw_all_versions_bytes:rawBytes,same_field_approved_bytes:selectedBytes,reduction_percent:round((1-selectedBytes/rawBytes)*100),full_context_compact_json_bytes:bytes(context),mcp_response_line_bytes:mcpOutput.wire_bytes},
      timing:{raw_version_serialization:rawSerialized,approved_serialization:selectedSerialized,store_context:storeContext,http_context_roundtrip:httpRoundtrip,stdio_mcp_context_roundtrip:stdio,process_start_to_initialize:coldInit.length?stats(coldInit):null,process_start_to_first_context:stats(coldFirstContext)},
      checks:{same_site_only:true,secrets_omitted:true,drafts_and_rejected_versions_omitted:true,nonshared_omitted:true,previous_approved_revision_retained:true}
    };
  }finally{
    if(client)await client.close();
    if(server?.listening)await new Promise(resolve=>server.close(resolve));
    store.close();rmSync(directory,{recursive:true,force:true});
  }
}

const report={
  generated_at:new Date().toISOString(),node:process.version,environment:{platform:platform(),arch:arch(),cpu:cpus()[0]?.model,cpu_count:cpus().length},
  methodology:{synthetic_only:true,material_counts:[10,100,500],versions_per_material:3,approved_shared_fraction:.7,warmup_requests:warmups,measured_sequential_requests:repetitions,cold_process_runs:coldRuns,percentile:'nearest-rank',scope:'Single local machine, sequential requests, warm OS filesystem cache. Store uses on-disk SQLite; HTTP and stdio use real transports. Request timing includes response parsing and boundary assertions.',payload_comparison:'Same field projection of every same-site version versus approved/shared same-site versions. This measures input selection, not search relevance, model quality, tokens or total AI cost.',limitations:['No actual LLM calls or token counts.','No concurrent-user or sustained load test.','Cold process runs reuse warmed OS filesystem cache; not a machine cold boot.','HTTP fetch uses local keep-alive; results depend on host load and hardware.']},
  scenarios:[]
};
for(const count of report.methodology.material_counts){const result=await scenario(count);report.scenarios.push(result);console.log(`${count} materials: Store ${result.timing.store_context.p95_ms} ms, HTTP ${result.timing.http_context_roundtrip.p95_ms} ms, MCP ${result.timing.stdio_mcp_context_roundtrip.p95_ms} ms (p95); input ${result.payload.reduction_percent}% smaller`);}
writeFileSync(join(root,'docs','runtime-benchmark.json'),JSON.stringify(report,null,2)+'\n');
console.log('Saved docs/runtime-benchmark.json. All synthetic boundary assertions passed; temporary databases removed.');
