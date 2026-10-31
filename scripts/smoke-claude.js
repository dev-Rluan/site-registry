import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Store } from '../store.js';

// This opt-in CLI uses the existing Claude Code login and its model allowance.
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const directory=mkdtempSync(join(process.env.SITE_REGISTRY_SMOKE_WORK||tmpdir(),'registry-claude-smoke-'));
const project=join(directory,'project'),data=join(directory,'data');
mkdirSync(join(project,'.claude','skills','site'),{recursive:true});mkdirSync(data,{recursive:true});
cpSync(join(root,'examples','site','SKILL.md'),join(project,'.claude','skills','site','SKILL.md'));
writeFileSync(join(project,'CLAUDE.md'),'This is an isolated synthetic smoke-test project. Read only this project and its configured site-registry MCP. Do not read any real company files, credentials, user settings, or other projects. Do not run shell commands, approve evidence, or contact external services.\n');
const setup=new Store(join(data,'demo.sqlite'),'synthetic-smoke-master-key-not-a-real-key-32');
setup.seedDemo();const before=setup.analyses(1).length,context=setup.context('demo-alpha');setup.close();
const config=join(directory,'mcp.json');
writeFileSync(config,JSON.stringify({mcpServers:{site_registry:{command:process.execPath,args:[join(root,'mcp.js')],env:{SITE_REGISTRY_DATA_DIR:data,SITE_REGISTRY_SITE:'demo-alpha',SITE_REGISTRY_DEMO:'1'}}}},null,2));
const toolNames=['list_sites','get_site_context','get_feature_map','save_evidence_draft','record_analysis'].map(name=>`mcp__site_registry__${name}`);
const prompt='/site 요구사항 가상 알파 사이트에서 금액이 같은 승인 이벤트를 모두 중복으로 확정해도 되나요? 기존 기능으로 안내할 수 있는지, 근거와 검토 기준으로 판단해주세요. list_sites, get_site_context, get_feature_map을 실제로 호출하고 record_analysis로 분석 1건을 저장하세요. 근거의 정확한 ID와 버전을 참조하고 사실과 추론을 구분하세요. 새 근거 초안 생성이나 운영 변경은 필요하지 않습니다. 결과는 600자 안팎으로 간단히 정리해주세요.';
const settings={disableAllHooks:true,autoMemoryEnabled:false};
writeFileSync(join(project,'.claude','settings.json'),JSON.stringify(settings));
const args=['-p',prompt,'--model','sonnet','--max-budget-usd','0.8','--output-format','stream-json','--verbose','--tools','Skill','--allowedTools',['Skill',...toolNames].join(','),'--disallowedTools','Bash,Edit,Write,Agent,WebFetch,WebSearch,NotebookEdit,Computer','--strict-mcp-config','--mcp-config',config,'--setting-sources','project','--settings',JSON.stringify(settings),'--permission-mode','dontAsk','--no-session-persistence','--no-chrome','--append-system-prompt','Synthetic integration test only. Follow the project /site skill. Read only this scratch project and the configured site_registry MCP. Do not access credentials, other files, real data, external tools, shell commands, subagents, or web sources. Do not approve evidence.'];
const cliVersion=execFileSync('claude',['--version'],{encoding:'utf8'}).trim();
const started=performance.now(),child=spawn('claude',args,{cwd:project,stdio:['ignore','pipe','pipe'],env:{...process.env,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}});
let stdout='',stderr='';
child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
const exit=await new Promise((resolveExit,reject)=>{
  const timeout=setTimeout(()=>child.kill('SIGTERM'),180000);
  child.once('error',error=>{clearTimeout(timeout);reject(error);});
  child.once('close',(code,signal)=>{clearTimeout(timeout);resolveExit({code,signal});});
});
writeFileSync(join(directory,'stdout.jsonl'),stdout);writeFileSync(join(directory,'stderr.log'),stderr);
writeFileSync(join(directory,'invocation.json'),JSON.stringify({cliVersion,args,cwd:project,exit},null,2));
const events=stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
const init=events.find(event=>event.type==='system'&&event.subtype==='init');
const result=events.findLast(event=>event.type==='result');
const calls=events.flatMap(event=>(event.message?.content||[]).filter(item=>item.type==='tool_use').map(item=>({name:item.name,id:item.id,input:item.input})));
const toolResults=events.flatMap(event=>(event.message?.content||[]).filter(item=>item.type==='tool_result'));
const successfulCalls=calls.filter(call=>toolResults.some(result=>result.tool_use_id===call.id&&result.is_error!==true));
const verify=new Store(join(data,'demo.sqlite'),null);
const analyses=verify.analyses(1);verify.close();
const saved=analyses.find(a=>a.source!=='수동 작성한 가상 /site 분석 예시');
const publicText=JSON.stringify(events);
const secretMarkers=['DEMO-NOT-A-REAL-TOKEN','DEMO-BATCH-SECRET-NOT-REAL','DEMO-BETA-BATCH-NOT-REAL','공유하지 않는 로컬 메모입니다.'];
const report={
  generated_at:new Date().toISOString(),cli_version:cliVersion,configured_model:init?.model,synthetic_only:true,elapsed_ms:Math.round(performance.now()-started),
  configuration:{separate_synthetic_project:true,project_skill:'/site',strict_mcp_config:true,hooks_disabled:true,settings_sources:['project'],builtin_tools:['Skill'],permission_mode:'dontAsk',permission_bypass:false,session_persistence:false,chrome:false,budget_usd:.8},
  exit,initial_mcp_status:init?.mcp_servers,allowed_mcp_tools:toolNames,tools_observed_in_initial_event:init?.tools,
  tool_calls:calls.map(({name,id,input})=>({name,successful:successfulCalls.some(call=>call.id===id),...(name.endsWith('record_analysis')?{evidence:input.evidence}:{} )})),
  result:{subtype:result?.subtype,is_error:result?.is_error,estimated_cost_usd:result?.total_cost_usd,usage:result?.usage,permission_denials:result?.permission_denials,...(result?.is_error?{error_message:result.result}:{})},
  checks:{cli_success:exit.code===0&&result?.subtype==='success'&&!result?.is_error&&result?.num_turns>0,site_skill_discovered:[...(init?.skills||[]),...(init?.slash_commands||[])].includes('site'),model_response_received:events.some(event=>event.type==='assistant'&&event.message?.model&&event.message.model!=='<synthetic>'),mcp_connected:init?.mcp_servers?.some(s=>s.name==='site_registry'&&s.status==='connected')||!!saved,required_mcp_calls:['list_sites','get_site_context','get_feature_map','record_analysis'].every(name=>successfulCalls.some(c=>c.name===`mcp__site_registry__${name}`)),only_allowed_tools_used:calls.every(c=>['Skill',...toolNames].includes(c.name)),one_analysis_saved:analyses.length===before+1,exact_approved_evidence_versions:!!saved&&saved.evidence.length>0&&saved.evidence.every(ref=>context.materials.some(m=>m.id===ref.material_id&&m.revision===ref.revision&&m.body===ref.body&&m.source===ref.source)),synthetic_secrets_absent:secretMarkers.every(marker=>!publicText.includes(marker)),other_site_policy_absent:!publicText.includes('가상 정책 BETA-01')},
  saved_analysis:saved?{id:saved.id,revision:saved.revision,mode:saved.mode,source:saved.source,result:saved.result,evidence:saved.evidence.map(ref=>({material_id:ref.material_id,revision:ref.revision,source:ref.source}))}:null,
  limitations:['Single synthetic end-to-end attempt; only a passed check establishes that step. This does not establish answer accuracy or productivity in production.','Reported USD value is Claude Code client estimate, not an invoice.','Only the requirement-review path is requested; draft creation is not required by this mode.','A separate synthetic working directory and tool allowlist are used; this is not an OS filesystem sandbox. Built-in file and shell tools are disabled.','Claude Code 2.1.220 can emit an initial MCP status of pending before discovery finishes; successful calls and persisted evidence determine connectivity.'],
  documentation:['https://code.claude.com/docs/en/headless','https://code.claude.com/docs/en/skills']
};
report.status=Object.values(report.checks).every(Boolean)?'passed':events.some(event=>event.error==='authentication_failed')?'blocked_authentication':'failed';
writeFileSync(join(root,'docs','claude-mcp-smoke.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Raw logs (local only): ${directory}`);
console.log(JSON.stringify({checks:report.checks,exit,elapsed_ms:report.elapsed_ms,estimated_cost_usd:report.result.estimated_cost_usd},null,2));
assert(Object.values(report.checks).every(Boolean),'Claude MCP smoke failed; inspect local logs and sanitized report.');
