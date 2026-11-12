import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.mjs';
import { LocalError } from '../src/errors.mjs';

const token='test-only-local-access-token-0123456789abcdef';
async function setup(t, options={}) {
  const root=await mkdtemp(join(await realpath(tmpdir()),'plompy-local-server-'));
  const config={schemaVersion:1,server:{host:'127.0.0.1',port:7331,allowedHosts:['127.0.0.1:7331'],allowedOrigins:[]},tokenFile:join(root,'secrets','token'),artifactsDir:join(root,'artifacts'),integrations:{web:{enabled:true},...options.integrations}};
  await mkdir(config.artifactsDir,{mode:0o700});
  const instance=await startServer(config,{token,port:0,toolOptions:options.toolOptions,requestMs:options.requestMs});
  const origin=`http://127.0.0.1:${instance.address.port}`;
  config.server.allowedHosts=[new URL(origin).host];
  const clients=[];
  async function connect(){const client=new Client({name:'test',version:'1'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));clients.push(client);return client;}
  t.after(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await instance.close();await rm(root,{recursive:true,force:true});});
  return {config,instance,origin,connect};
}
const data=result=>JSON.parse(result.content[0].text);
test('actual SDK initialize, discovery and local export work without Discord or model accounts',async t=>{
  const {connect}=await setup(t);const client=await connect();
  const names=(await client.listTools()).tools.map(tool=>tool.name);
  assert.deepEqual(names,['plompy_status','artifacts_export','artifacts_list','artifacts_read','web_fetch']);
  assert.equal(data(await client.callTool({name:'plompy_status',arguments:{}})).profile,'research');
  const args={name:'companies.csv',format:'csv',records:[{company_name:'Fixture Company',public_email:'contact@example.test',source_url:'https://example.test/contact',draft_subject:'University project',draft_body:'=2+3'}],idempotencyKey:'fixture-export'};
  const first=data(await client.callTool({name:'artifacts_export',arguments:args}));
  const second=data(await client.callTool({name:'artifacts_export',arguments:args}));
  assert.equal(first.sha256,second.sha256);assert.equal(second.reused,true);
  const read=await client.callTool({name:'artifacts_read',arguments:{name:'companies.csv'}});
  assert.match(data(read).content,/Fixture Company/);assert.doesNotMatch(data(read).content,/,=2\+3/);
});
test('auth, Host, Origin, exact endpoint, methods and JSON limits fail closed',async t=>{
  const {origin}=await setup(t);
  assert.equal((await fetch(origin+'/mcp',{method:'POST'})).status,401);
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const hostStatus=await new Promise((resolve,reject)=>{const req=httpRequest(origin+'/mcp',{method:'POST',headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end('{}');});
  assert.equal(hostStatus,403);
  assert.equal((await fetch(origin+'/mcp',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await fetch(origin+'/mcp?token=x',{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fetch(origin+'/mcp',{headers})).status,405);
  assert.equal((await fetch(origin+'/mcp',{method:'POST',headers,body:'bad-json'})).status,400);
  assert.equal((await fetch(origin+'/mcp',{method:'POST',headers,body:JSON.stringify({data:'x'.repeat(2_097_152)})})).status,413);
});
test('unknown tools, incorrect schemas, paths and credential export are refused',async t=>{
  const {connect}=await setup(t);const client=await connect();
  for(const request of [
    {name:'execute',arguments:{command:'anything'}},
    {name:'web_fetch',arguments:{url:'https://example.com',extra:'not permitted'}},
    {name:'artifacts_export',arguments:{name:'../escape.json',format:'json',records:[]}},
    {name:'artifacts_export',arguments:{name:'secret.md',format:'markdown',content:token}},
  ])assert.equal((await client.callTool(request)).isError,true);
});
test('network rejects private targets and response tokens are redacted',async t=>{
  const {connect}=await setup(t,{toolOptions:{fetchImpl:async()=>({url:'https://example.com',status:200,headers:{'content-type':'text/plain'},body:Buffer.from('echo '+token)})}});
  const client=await connect();const result=await client.callTool({name:'web_fetch',arguments:{url:'https://example.com'}});
  assert.equal(result.isError,undefined);assert.doesNotMatch(JSON.stringify(result),new RegExp(token));assert.match(JSON.stringify(result),/REDACTED/);
  const {connect:connectReal}=await setup(t);const real=await connectReal();
  assert.equal((await real.callTool({name:'web_fetch',arguments:{url:'http://127.0.0.1/'}})).isError,true);
});
test('one broken integration does not hide working local tools or leak provider diagnostics',async t=>{
  const {connect}=await setup(t,{integrations:{perplexity:{enabled:true,auth:'api-key',allowedTools:['perplexity_search']}},toolOptions:{remoteConnector:async()=>{throw new Error('private-path '+token);}}});
  const client=await connect();assert.ok((await client.listTools()).tools.some(tool=>tool.name==='artifacts_export'));
  const result=await client.callTool({name:'plompy_status',arguments:{}});
  assert.equal(data(result).integrations.find(row=>row.id==='perplexity').state,'unavailable');assert.doesNotMatch(JSON.stringify(result),/private-path/);
});
test('timeout is bounded, does not retry adapter calls and keeps server usable',async t=>{
  let calls=0;
  const {connect}=await setup(t,{requestMs:80,toolOptions:{fetchImpl:async(_url,{signal})=>{calls++;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new LocalError('TIMEOUT')),{once:true}));}}});
  const client=await connect();const result=await client.callTool({name:'web_fetch',arguments:{url:'https://example.com'}});
  assert.equal(data(result).code,'TIMEOUT');assert.equal(calls,1);assert.equal(data(await client.callTool({name:'plompy_status',arguments:{}})).profile,'research');
});
test('four concurrent calls are bounded and a fifth is refused without invoking its adapter',async t=>{
  const releases=[];let allStarted;const started=new Promise(resolve=>{allStarted=resolve;});
  const {connect,origin}=await setup(t,{toolOptions:{fetchImpl:async(_url,{signal})=>{
    await new Promise((resolve,reject)=>{releases.push(resolve);signal.addEventListener('abort',()=>reject(new LocalError('TIMEOUT')),{once:true});if(releases.length===4)allStarted();});
    return {url:'https://example.com',status:200,headers:{'content-type':'text/plain'},body:Buffer.from('bounded')};
  }}});
  const client=await connect();
  const calls=Array.from({length:4},()=>client.callTool({name:'web_fetch',arguments:{url:'https://example.com'}}));
  try{
    await started;
    const refused=await fetch(origin+'/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'web_fetch',arguments:{url:'https://example.com'}}})});
    assert.equal(refused.status,429);assert.equal(releases.length,4);
  }finally{for(const release of releases)release();await Promise.all(calls);}
});
test('stalled authenticated request bodies release their slot at the deadline',async t=>{
  const {origin}=await setup(t,{requestMs:60});
  const started=Date.now();
  await new Promise((resolve,reject)=>{
    const req=httpRequest(origin+'/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':'1024'}},res=>res.resume());
    const timeout=setTimeout(()=>{req.destroy();reject(new Error('Stalled request exceeded the deadline.'));},1000);
    req.on('error',()=>{});req.on('close',()=>{clearTimeout(timeout);resolve();});req.write('{');
  });
  assert.ok(Date.now()-started<1000);
  assert.equal((await fetch(origin+'/health',{headers:{authorization:`Bearer ${token}`}})).status,200);
});
test('repeatable fixture research reads sources, deduplicates and exports drafts through MCP',async t=>{
  const pages={'/search':'<a href="/alpha">Alpha</a><a href="/alpha">Alpha duplicate</a><a href="/beta">Beta</a>','/alpha':'<h1>Alpha Mobile</h1><p>Mobile applications in Poland</p><a href="mailto:contact@alpha.test">Contact</a>','/beta':'<h1>Beta Apps</h1><p>Android applications in Poland</p><p>team@beta.test</p>'};
  const fixture=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(pages[req.url]??'');});
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>fixture.close(resolve)));
  const base=`http://127.0.0.1:${fixture.address().port}`;
  const {connect}=await setup(t,{toolOptions:{networkOptions:{allowHostsForTests:[new URL(base).host]}}});const client=await connect();
  const search=data(await client.callTool({name:'web_fetch',arguments:{url:base+'/search'}}));
  const paths=[...new Set([...search.content.matchAll(/href="([^"]+)"/g)].map(match=>match[1]))];assert.equal(paths.length,2);
  const records=[];
  for(const path of paths){const page=data(await client.callTool({name:'web_fetch',arguments:{url:base+path}}));const name=page.content.match(/<h1>([^<]+)/)[1];const email=page.content.match(/[\w.]+@[\w.]+\.test/)[0];records.push({company_name:name,website:base+path,industry:'Mobile applications',location:'Poland',public_email:email,source_url:page.url,checked_at:page.checked_at,match_reason:'The fixture page explicitly describes mobile applications in Poland.',evidence_status:'published_on_source_not_deliverability_verified',draft_subject:'University project collaboration',draft_body:`Hello ${name}, your page describes mobile application work. Would you consider discussing a university project?`});}
  const result=await client.callTool({name:'artifacts_export',arguments:{name:'research.json',format:'json',records}});assert.equal(result.isError,undefined);
  const saved=data(await client.callTool({name:'artifacts_read',arguments:{name:'research.json'}}));assert.equal(JSON.parse(saved.content).length,2);
  // Fixture extraction/drafting here is deterministic test code, not a live LLM.
});
