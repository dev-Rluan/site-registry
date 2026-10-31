import http from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, InputError, masterKey } from './store.js';

const root=dirname(fileURLToPath(import.meta.url));
const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/styles.css',['styles.css','text/css; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']]]);
async function body(req){
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new InputError('JSON 요청이 필요합니다.',415);
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>500000)throw new InputError('요청이 너무 큽니다.',413);chunks.push(chunk);}
  let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new InputError('JSON 형식을 확인해주세요.');}
  if(!result||typeof result!=='object'||Array.isArray(result))throw new InputError('JSON 객체로 입력해주세요.');return result;
}
export function createServer(store){
  return http.createServer(async(req,res)=>{
    const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
    const json=(status,data)=>{res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    try{
      const host=req.headers.host;
      if(!/^127\.0\.0\.1:\d+$/.test(host||''))throw new InputError('127.0.0.1 주소로 접속해주세요.',403);
      if(req.headers.origin&&req.headers.origin!==`http://${host}`)throw new InputError('다른 출처의 요청은 허용하지 않습니다.',403);
      if(req.headers['sec-fetch-site']==='cross-site')throw new InputError('다른 사이트 요청은 허용하지 않습니다.',403);
      const path=new URL(req.url,`http://${host}`).pathname;let match,result;
      if(req.method==='GET'&&assets.has(path)){const[name,type]=assets.get(path);res.writeHead(200,{...headers,'Content-Type':type});res.end(readFileSync(join(root,'public',name)));return;}
      if(req.method==='GET'&&path==='/api/sites')result=store.sites();
      else if(req.method==='POST'&&path==='/api/sites')result=store.createSite(await body(req));
      else if(req.method==='GET'&&(match=path.match(/^\/api\/sites\/(\d+)$/)))result=store.detail(match[1]);
      else if(req.method==='PUT'&&(match=path.match(/^\/api\/sites\/(\d+)\/config$/)))result=store.saveConfig(match[1],await body(req));
      else if(req.method==='POST'&&(match=path.match(/^\/api\/sites\/(\d+)\/materials$/)))result=store.saveMaterial(match[1],await body(req));
      else if(req.method==='PUT'&&(match=path.match(/^\/api\/sites\/(\d+)\/materials\/(\d+)$/)))result=store.saveMaterial(match[1],await body(req),match[2]);
      else if(req.method==='POST'&&(match=path.match(/^\/api\/sites\/(\d+)\/materials\/(\d+)\/review$/)))result=store.reviewMaterial(match[1],match[2],await body(req));
      else if(req.method==='GET'&&(match=path.match(/^\/api\/sites\/(\d+)\/feature-map$/)))result=store.featureMap(match[1]);
      else if(req.method==='POST'&&(match=path.match(/^\/api\/sites\/(\d+)\/batches$/)))result=store.createBatch(match[1],await body(req));
      else if(req.method==='POST'&&(match=path.match(/^\/api\/sites\/(\d+)\/analyses$/)))result=store.saveAnalysis(match[1],await body(req));
      else if(req.method==='PUT'&&(match=path.match(/^\/api\/sites\/(\d+)\/analyses\/(\d+)$/)))result=store.saveAnalysis(match[1],await body(req),match[2]);
      else if(req.method==='GET'&&(match=path.match(/^\/api\/sites\/(\d+)\/context$/)))result=store.context(store.requireSite(match[1]).slug);
      else throw new InputError('요청한 경로를 찾을 수 없습니다.',404);
      json(req.method==='POST'?201:200,result);
    }catch(error){const status=error instanceof InputError?error.status:500;if(status===500)console.error('저장 처리 실패');json(status,{error:status===500?'처리하지 못했습니다. 서버 상태를 확인해주세요.':error.message});}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const directory=resolve(process.env.SITE_REGISTRY_DATA_DIR||join(root,'.data'));
  mkdirSync(directory,{recursive:true,mode:0o700});
  const demo=process.argv.includes('--demo'),store=new Store(join(directory,demo?'demo.sqlite':'registry.sqlite'),masterKey(directory));
  if(demo&&!store.sites().length)store.seedDemo();
  const server=createServer(store),port=Number(process.env.PORT||4174);
  server.listen(port,'127.0.0.1',()=>console.log(`Site Registry: http://127.0.0.1:${server.address().port}${demo?' (가상 예시)':''}`));
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'포트가 사용 중입니다. PORT 값을 변경해주세요.':error.message);store.close();process.exitCode=1;});
  for(const signal of['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));
}
