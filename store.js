import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class InputError extends Error {
  constructor(message, status=400) { super(message); this.status=status; }
}
function text(value,label,max,required=true) {
  if (value===undefined && !required) return '';
  if (typeof value!=='string' || value.length>max || (required && !value.trim())) throw new InputError(`${label} 입력을 확인해주세요. (최대 ${max}자)`);
  return value.trim();
}
function id(value) {
  const n=Number(value);
  if (!Number.isSafeInteger(n)||n<1) throw new InputError('식별자가 올바르지 않습니다.');
  return n;
}
function object(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new InputError('설정은 JSON 객체여야 합니다.');
  const result=JSON.stringify(value);
  if (result.length>100000) throw new InputError('설정 크기는 100,000자 이하여야 합니다.');
  return result;
}
export function masterKey(directory, supplied=process.env.SITE_REGISTRY_KEY) {
  if (supplied!==undefined) {
    if (supplied.length<32) throw new Error('SITE_REGISTRY_KEY는 32자 이상이어야 합니다.');
    return supplied;
  }
  mkdirSync(directory,{recursive:true,mode:0o700});
  const path=join(directory,'master.key');
  if (!existsSync(path)) writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
  chmodSync(path,0o600);
  const key=readFileSync(path,'utf8').trim();
  if(key.length<32) throw new Error('암호화 키 파일이 손상되었습니다.');
  return key;
}
export function encrypt(value,key,aad) {
  const salt=randomBytes(16),iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',scryptSync(key,salt,32),iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return JSON.stringify({v:1,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
}
export function decrypt(envelope,key,aad) {
  const e=JSON.parse(envelope);
  if(e.v!==1) throw new Error('지원하지 않는 암호화 형식입니다.');
  const cipher=createDecipheriv('aes-256-gcm',scryptSync(key,Buffer.from(e.salt,'base64'),32),Buffer.from(e.iv,'base64'));
  cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(Buffer.from(e.tag,'base64'));
  return Buffer.concat([cipher.update(Buffer.from(e.ciphertext,'base64')),cipher.final()]).toString('utf8');
}
const now=()=>new Date().toISOString();
export class Store {
  constructor(path=':memory:',key=null,{readOnly=false}={}) {
    this.key=key;this.db=new DatabaseSync(path,{readOnly});
    if(!readOnly) {
      this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS sites(id INTEGER PRIMARY KEY,slug TEXT UNIQUE NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS configs(site_id INTEGER NOT NULL REFERENCES sites(id),revision INTEGER NOT NULL,envelope TEXT NOT NULL,field_count INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(site_id,revision));
        CREATE TABLE IF NOT EXISTS materials(id INTEGER PRIMARY KEY,site_id INTEGER NOT NULL REFERENCES sites(id),kind TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS material_versions(material_id INTEGER NOT NULL REFERENCES materials(id),revision INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,source TEXT NOT NULL,shared INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(material_id,revision));
        CREATE TABLE IF NOT EXISTS reviews(material_id INTEGER NOT NULL,revision INTEGER NOT NULL,decision TEXT NOT NULL,reviewer TEXT NOT NULL,note TEXT NOT NULL,reviewed_at TEXT NOT NULL,PRIMARY KEY(material_id,revision),FOREIGN KEY(material_id,revision) REFERENCES material_versions(material_id,revision));
        CREATE TABLE IF NOT EXISTS batches(id INTEGER PRIMARY KEY,site_id INTEGER NOT NULL REFERENCES sites(id),code TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,schedule TEXT NOT NULL,secret_envelope TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(site_id,code));
        CREATE TABLE IF NOT EXISTS analyses(id INTEGER PRIMARY KEY,site_id INTEGER NOT NULL REFERENCES sites(id));
        CREATE TABLE IF NOT EXISTS analysis_versions(analysis_id INTEGER NOT NULL REFERENCES analyses(id),revision INTEGER NOT NULL,request TEXT NOT NULL,mode TEXT NOT NULL,result TEXT NOT NULL,source TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(analysis_id,revision));`);
      if(key) for(const row of this.all('SELECT * FROM configs')) {
        try { decrypt(row.envelope,key,`site:${row.site_id}:config:${row.revision}`); }
        catch { this.close();throw new Error('암호화 키가 저장된 설정과 일치하지 않습니다. 기존 키를 확인해주세요.'); }
      }
      if(key) for(const row of this.all("SELECT * FROM batches WHERE secret_envelope<>''")) {
        try { decrypt(row.secret_envelope,key,`site:${row.site_id}:batch:${row.code}`); }
        catch { this.close();throw new Error('암호화 키가 저장된 배치와 일치하지 않습니다. 기존 키를 확인해주세요.'); }
      }
    }
  }
  close(){this.db.close();}
  one(sql,...params){return this.db.prepare(sql).get(...params);}
  all(sql,...params){return this.db.prepare(sql).all(...params);}
  run(sql,...params){return this.db.prepare(sql).run(...params);}
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  requireSite(siteId){const s=this.one('SELECT * FROM sites WHERE id=?',id(siteId));if(!s)throw new InputError('사이트를 찾을 수 없습니다.',404);return s;}
  siteBySlug(slug){const s=this.one('SELECT * FROM sites WHERE slug=?',slug);if(!s)throw new InputError('사이트를 찾을 수 없습니다.',404);return s;}
  sites(){return this.all('SELECT * FROM sites ORDER BY id').map(s=>({...s,material_count:this.one('SELECT count(*) AS n FROM materials WHERE site_id=?',s.id).n,config_revision:this.configMeta(s.id).revision}));}
  createSite(input){
    const slug=text(input.slug,'사이트 코드',60),name=text(input.name,'사이트 이름',120),description=text(input.description,'설명',2000,false);
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))throw new InputError('사이트 코드는 영문 소문자·숫자·하이픈으로 입력해주세요.');
    if(this.one('SELECT id FROM sites WHERE slug=?',slug))throw new InputError('이미 사용 중인 사이트 코드입니다.',409);
    return {id:Number(this.run('INSERT INTO sites(slug,name,description,created_at) VALUES(?,?,?,?)',slug,name,description,now()).lastInsertRowid)};
  }
  configMeta(siteId){const versions=this.all('SELECT revision,field_count,created_at FROM configs WHERE site_id=? ORDER BY revision DESC',siteId);return {revision:versions[0]?.revision||0,versions};}
  saveConfig(siteId,input){
    this.requireSite(siteId);siteId=id(siteId);
    if(!this.key)throw new InputError('설정 저장 키가 없습니다.',503);
    const value=object(input.config);
    return this.tx(()=>{
      const current=this.configMeta(siteId).revision;
      if(input.base_revision!==current)throw new InputError('설정 버전이 변경되었습니다. 새로고침 후 다시 저장해주세요.',409);
      const revision=current+1,envelope=encrypt(value,this.key,`site:${siteId}:config:${revision}`);
      this.run('INSERT INTO configs VALUES(?,?,?,?,?)',siteId,revision,envelope,Object.keys(input.config).length,now());
      return {revision};
    });
  }
  saveMaterial(siteId,input,materialId=null){
    this.requireSite(siteId);siteId=id(siteId);
    const kind=text(input.kind,'자료 종류',20),title=text(input.title,'제목',200),body=text(input.body,'내용',100000),source=text(input.source,'출처',2000,false);
    if(!['feature','criterion','policy','document','raw_data'].includes(kind))throw new InputError('자료 종류가 올바르지 않습니다.');
    if(typeof input.shared!=='boolean')throw new InputError('MCP 공유 여부를 선택해주세요.');
    if(kind==='raw_data'){let parsed;try{parsed=JSON.parse(body);}catch{throw new InputError('원데이터는 JSON 객체 또는 배열이어야 합니다.');}if(!parsed||typeof parsed!=='object')throw new InputError('원데이터는 JSON 객체 또는 배열이어야 합니다.');}
    if(kind==='feature')this.featureDefinition(body,siteId);
    return this.tx(()=>{
      let revision=1;
      if(materialId!==null){
        materialId=id(materialId);
        const current=this.one('SELECT * FROM materials WHERE id=? AND site_id=?',materialId,siteId);
        if(!current)throw new InputError('이 사이트의 자료를 찾을 수 없습니다.',404);
        if(current.kind!==kind)throw new InputError('자료 종류는 변경할 수 없습니다. 새 자료로 등록해주세요.');
        const last=this.one('SELECT MAX(revision) AS n FROM material_versions WHERE material_id=?',materialId).n;
        if(input.base_revision!==last)throw new InputError('자료 버전이 변경되었습니다. 최신 내용을 다시 확인해주세요.',409);
        revision=last+1;
      } else materialId=Number(this.run('INSERT INTO materials(site_id,kind) VALUES(?,?)',siteId,kind).lastInsertRowid);
      this.run('INSERT INTO material_versions VALUES(?,?,?,?,?,?,?)',materialId,revision,title,body,source,Number(input.shared),now());
      return {id:materialId,revision};
    });
  }
  featureDefinition(body,siteId){
    let value;try{value=JSON.parse(body);}catch{throw new InputError('기능 정의는 JSON 객체여야 합니다.');}
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['summary','rules','related_ids'].includes(k)))throw new InputError('기능 정의는 summary, rules, related_ids로 작성해주세요.');
    text(value.summary,'기능 설명',5000);
    if(!Array.isArray(value.rules)||value.rules.length>50)throw new InputError('rules는 규칙 문자열 배열이어야 합니다.');
    value.rules.forEach(rule=>text(rule,'기능 규칙',2000));
    if(!Array.isArray(value.related_ids)||value.related_ids.length>30||new Set(value.related_ids).size!==value.related_ids.length)throw new InputError('related_ids는 중복 없는 자료 ID 배열이어야 합니다.');
    for(const reference of value.related_ids){
      if(!Number.isSafeInteger(reference)||!this.one('SELECT id FROM materials WHERE id=? AND site_id=?',reference,siteId))throw new InputError('같은 사이트의 자료 ID만 연결할 수 있습니다.');
    }
    return value;
  }
  materials(siteId){return this.all('SELECT * FROM materials WHERE site_id=? ORDER BY id',siteId).map(m=>{
    const versions=this.all('SELECT v.*, r.decision AS status, r.reviewer, r.note, r.reviewed_at FROM material_versions v LEFT JOIN reviews r ON r.material_id=v.material_id AND r.revision=v.revision WHERE v.material_id=? ORDER BY v.revision DESC',m.id).map(v=>({...v,status:v.status||'draft',shared:Boolean(v.shared)}));
    return {...m,...versions[0],approved_revision:versions.find(v=>v.status==='approved')?.revision||0,versions};
  });}
  reviewMaterial(siteId,materialId,input){
    this.requireSite(siteId);materialId=id(materialId);const revision=id(input.revision);
    if(!['approved','rejected'].includes(input.decision))throw new InputError('검토 결과가 올바르지 않습니다.');
    const reviewer=text(input.reviewer,'검토자',100),note=text(input.note,'검토 의견',2000,false);
    return this.tx(()=>{
      const material=this.materials(id(siteId)).find(m=>m.id===materialId);
      if(!material)throw new InputError('이 사이트의 자료를 찾을 수 없습니다.',404);
      if(material.revision!==revision||material.status!=='draft')throw new InputError('최신 초안만 검토할 수 있습니다. 내용을 다시 확인해주세요.',409);
      if(input.decision==='approved'&&!material.source.trim())throw new InputError('승인할 자료의 출처를 입력해주세요.');
      this.run('INSERT INTO reviews VALUES(?,?,?,?,?,?)',materialId,revision,input.decision,reviewer,note,now());
      return {id:materialId,revision,status:input.decision};
    });
  }
  approvedMaterials(siteId){
    return this.materials(siteId).flatMap(m=>{
      const approved=m.versions.find(v=>v.revision===m.approved_revision);
      if(!approved||!approved.shared)return [];
      const {revision,title,body,source,created_at,reviewer,reviewed_at}=approved;
      return [{id:m.id,kind:m.kind,revision,title,body,source,created_at,reviewer,reviewed_at}];
    });
  }
  featureMap(siteId){
    const site=this.requireSite(siteId),approved=this.approvedMaterials(site.id);
    const ids=new Set(approved.map(m=>m.id));
    const nodes=approved.map(m=>({...m,...(m.kind==='feature'?{definition:this.featureDefinition(m.body,site.id)}:{})}));
    const edges=nodes.flatMap(m=>(m.definition?.related_ids||[]).filter(target=>ids.has(target)).map(target=>({from:m.id,to:target,type:'references'})));
    return {site,nodes,edges};
  }
  createBatch(siteId,input){
    this.requireSite(siteId);siteId=id(siteId);
    const code=text(input.code,'배치 코드',60),name=text(input.name,'배치 이름',120),description=text(input.description,'배치 설명',3000,false),schedule=text(input.schedule,'실행 주기',200,false);
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code))throw new InputError('배치 코드는 영문 소문자·숫자·하이픈으로 입력해주세요.');
    if(this.one('SELECT id FROM batches WHERE site_id=? AND code=?',siteId,code))throw new InputError('이미 사용 중인 배치 코드입니다.',409);
    const secrets=input.secrets===undefined?{}:input.secrets,plaintext=object(secrets);
    if(Object.keys(secrets).length&&!this.key)throw new InputError('비밀 설정 저장 키가 없습니다.',503);
    const envelope=Object.keys(secrets).length?encrypt(plaintext,this.key,`site:${siteId}:batch:${code}`):'';
    const result=this.run('INSERT INTO batches(site_id,code,name,description,schedule,secret_envelope,created_at) VALUES(?,?,?,?,?,?,?)',siteId,code,name,description,schedule,envelope,now());
    return this.batches(siteId).find(b=>b.id===Number(result.lastInsertRowid));
  }
  batches(siteId){return this.all("SELECT id,code,name,description,schedule,created_at,(secret_envelope<>'') AS has_secret FROM batches WHERE site_id=? ORDER BY id",siteId).map(b=>({...b,has_secret:Boolean(b.has_secret)}));}
  saveAnalysis(siteId,input,analysisId=null){
    this.requireSite(siteId);siteId=id(siteId);
    const request=text(input.request,'분석 요청',10000),result=text(input.result,'분석 결과',100000),source=text(input.source,'분석 출처',2000);
    if(!['requirement','risk'].includes(input.mode))throw new InputError('분석 기준을 선택해주세요.');
    if(!Array.isArray(input.evidence)||!input.evidence.length||input.evidence.length>50)throw new InputError('승인된 근거를 하나 이상 선택해주세요.');
    return this.tx(()=>{
      const seen=new Set();
      const evidence=input.evidence.map(ref=>{
        if(!ref||typeof ref!=='object'||Array.isArray(ref))throw new InputError('근거 참조를 확인해주세요.');
        const mid=id(ref.material_id),revision=id(ref.revision),key=`${mid}:${revision}`;
        if(seen.has(key))throw new InputError('중복된 근거 참조입니다.');seen.add(key);
        const v=this.one("SELECT m.id AS material_id,m.kind,v.revision,v.title,v.body,v.source,r.reviewer,r.reviewed_at FROM materials m JOIN material_versions v ON v.material_id=m.id JOIN reviews r ON r.material_id=v.material_id AND r.revision=v.revision WHERE m.id=? AND m.site_id=? AND v.revision=? AND r.decision='approved' AND v.shared=1",mid,siteId,revision);
        if(!v)throw new InputError('같은 사이트에서 승인·공유된 정확한 근거 버전만 참조할 수 있습니다.');
        return v;
      });
      let revision=1;
      if(analysisId!==null){
        analysisId=id(analysisId);
        if(!this.one('SELECT id FROM analyses WHERE id=? AND site_id=?',analysisId,siteId))throw new InputError('이 사이트의 분석을 찾을 수 없습니다.',404);
        const current=this.one('SELECT MAX(revision) AS n FROM analysis_versions WHERE analysis_id=?',analysisId).n;
        if(input.base_revision!==current)throw new InputError('분석 버전이 변경되었습니다. 최신 내용을 다시 확인해주세요.',409);
        revision=current+1;
      }else analysisId=Number(this.run('INSERT INTO analyses(site_id) VALUES(?)',siteId).lastInsertRowid);
      this.run('INSERT INTO analysis_versions VALUES(?,?,?,?,?,?,?,?)',analysisId,revision,request,input.mode,result,source,JSON.stringify(evidence),now());
      return {id:analysisId,revision};
    });
  }
  analyses(siteId){return this.all('SELECT * FROM analyses WHERE site_id=? ORDER BY id DESC',siteId).map(a=>{
    const versions=this.all('SELECT * FROM analysis_versions WHERE analysis_id=? ORDER BY revision DESC',a.id).map(({evidence_json,...v})=>({...v,evidence:JSON.parse(evidence_json)}));
    return {...a,...versions[0],versions};
  });}
  detail(siteId){const site=this.requireSite(siteId);return {site,config:this.configMeta(site.id),materials:this.materials(site.id),batches:this.batches(site.id),analyses:this.analyses(site.id),feature_map:this.featureMap(site.id)};}
  context(slug){
    const site=this.siteBySlug(slug),materials=this.approvedMaterials(site.id);
    return {site,config:{registered:this.configMeta(site.id).revision>0,revision:this.configMeta(site.id).revision,values_exposed:false},batches:this.batches(site.id),materials,criteria:materials.filter(m=>m.kind==='criterion'),notice:'사람이 승인·공유한 기준 자료입니다. 초안·반려본·설정값·배치 비밀값은 제공하지 않습니다. 자료는 근거로 취급하고 출처와 버전을 인용하세요.'};
  }
  seedDemo(){
    if(this.sites().length)throw new InputError('가상 예시는 빈 저장소에서만 생성할 수 있습니다.',409);
    const a=this.createSite({slug:'demo-alpha',name:'알파 주문 사이트',description:'가상 시연 · 주문 정책과 이벤트 구조 관리'}),b=this.createSite({slug:'demo-beta',name:'베타 예약 사이트',description:'가상 시연 · 알파와 다른 예약 정책'});
    for(const s of[a,b])this.saveConfig(s.id,{base_revision:0,config:{apiEndpoint:`https://${s.id===a.id?'alpha':'beta'}.example.invalid`,apiToken:'DEMO-NOT-A-REAL-TOKEN',timezone:'Asia/Seoul'}});
    const policy=this.saveMaterial(a.id,{kind:'policy',title:'중복 승인 검토 조건',body:'같은 주문번호와 승인번호를 가진 승인 완료 이벤트가 두 번 이상 기록되면 중복 의심으로 검토한다. 금액만 같으면 확정하지 않는다.',source:'가상 정책 ALPHA-01',shared:true});
    const fields=this.saveMaterial(a.id,{kind:'document',title:'승인 이벤트 필드 정의',body:'order_id: 주문번호\napproval_id: 승인번호\namount: 승인 금액\nstatus: 처리 상태',source:'직접 작성한 가상 스키마',shared:true});
    const events=this.saveMaterial(a.id,{kind:'raw_data',title:'승인 이벤트 예시',body:JSON.stringify([{order_id:'A-101',approval_id:'OK-01',amount:12000,status:'approved'},{order_id:'A-102',approval_id:'OK-02',amount:12000,status:'approved'}],null,2),source:'직접 작성한 가상 데이터',shared:true});
    this.saveMaterial(a.id,{kind:'document',title:'검토 중 메모',body:'공유하지 않는 로컬 메모입니다.',source:'가상 작성 메모',shared:false});
    const betaPolicy=this.saveMaterial(b.id,{kind:'policy',title:'예약 취소 정책',body:'가상 베타 사이트는 이용일 1일 전까지 취소 요청을 접수한다. 알파 주문 사이트의 승인 정책과 혼용하지 않는다.',source:'가상 정책 BETA-01',shared:true});
    const criterion=this.saveMaterial(a.id,{kind:'criterion',title:'요구사항과 리스크를 검토하는 기준',body:'요구사항을 기존 기능 활용·기존 기능 확장·신규 기능으로 구분한다. 승인된 근거의 ID와 버전을 인용하고, 영향 범위와 불확실성을 적는다. 변경 범위가 작은 대안을 우선 검토하며 사람의 최종 판단을 돕는다.',source:'가상 Skill 검토 기준 1판',shared:true});
    const definition={summary:'승인 이벤트의 중복 의심 여부를 검토하는 기능',rules:['같은 주문번호와 승인번호를 확인한다.','동일 금액만으로 중복 승인을 확정하지 않는다.'],related_ids:[policy.id,fields.id]};
    const feature=this.saveMaterial(a.id,{kind:'feature',title:'중복 승인 검토 기능',body:JSON.stringify(definition,null,2),source:'가상 코드 approval-check.js 및 정책 ALPHA-01',shared:true});
    for(const material of[policy,fields,events,criterion,feature])this.reviewMaterial(a.id,material.id,{revision:1,decision:'approved',reviewer:'가상 검토자',note:'시연을 위해 수동 작성한 가상 승인 기록입니다.'});
    this.reviewMaterial(b.id,betaPolicy.id,{revision:1,decision:'approved',reviewer:'가상 검토자',note:'가상 베타 정책 확인'});
    this.saveMaterial(a.id,{kind:'feature',title:'중복 승인 검토 기능',body:JSON.stringify({...definition,summary:'검토 중인 새 기능 정의 — 아직 기준본에 반영되지 않습니다.'},null,2),source:'가상 변경 초안 v2',shared:true,base_revision:1},feature.id);
    this.createBatch(a.id,{code:'daily-approval-sync',name:'일일 승인 내역 동기화',description:'승인 이벤트를 모으는 가상 배치의 등록 정보. 실행 기능은 없습니다.',schedule:'매일 02:00',secrets:{apiToken:'DEMO-BATCH-SECRET-NOT-REAL'}});
    this.createBatch(b.id,{code:'reservation-check',name:'예약 상태 점검',description:'베타 사이트의 가상 예약 배치',schedule:'매시간',secrets:{apiToken:'DEMO-BETA-BATCH-NOT-REAL'}});
    this.saveAnalysis(a.id,{request:'금액이 같은 승인 이벤트를 모두 중복으로 판단해도 되는가?',mode:'requirement',result:'기존 중복 승인 검토 기능의 가이드 대상이다. 금액만으로 확정하지 않고 주문번호·승인번호와 승인 완료 상태를 확인하도록 안내한다. 실제 데이터 없이 중복 여부를 확정하지 않는다.',source:'수동 작성한 가상 /site 분석 예시',evidence:[policy,criterion,feature].map(m=>({material_id:m.id,revision:1}))});
    return {ok:true};
  }
}
