import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteFetch, inspectRemoteIntegration, connectRemote } from '../src/remote.mjs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { safeFetch } from '../src/network.mjs';

test('remote transport rejects redirects and unsupported methods and never retries failures',async()=>{
  for(const status of [301,401,403,429,500]){
    let calls=0;const run=createRemoteFetch('https://vendor.example/mcp',{}, {fetchImpl:async()=>{calls++;return {status,headers:{},body:Buffer.from('private-provider-error')};}});
    await assert.rejects(run('https://vendor.example/mcp',{method:'POST',body:'{}'}),error=>!error.message.includes('private-provider-error'));
    assert.equal(calls,1);
  }
});
test('remote bridge fixes endpoint, strips arbitrary headers and bounds inputs',async()=>{
  let seen;const run=createRemoteFetch('https://vendor.example/mcp',{Authorization:'Bearer fixture-secret'},{fetchImpl:async(url,options)=>{seen={url,options};return {status:200,headers:{'content-type':'application/json'},body:Buffer.from('{}')};}});
  await run('https://vendor.example/mcp',{method:'POST',body:'{}',headers:{Cookie:'private','content-type':'application/json'}});
  assert.equal(seen.options.headers.Cookie,undefined);assert.equal(seen.options.headers.Authorization,'Bearer fixture-secret');
  assert.equal(seen.options.followRedirects,false);
  await assert.rejects(run('https://other.example/mcp',{method:'POST',body:'{}'}));
  await assert.rejects(run('https://vendor.example/mcp',{method:'DELETE'}));
  await assert.rejects(run('https://vendor.example/mcp',{method:'POST',body:'x'.repeat(1_048_577)}));
});
test('missing credentials and unsupported autonomous integration remain distinct',async()=>{
  const missing=await inspectRemoteIntegration('perplexity',{enabled:true,auth:'api-key',allowedTools:['perplexity_search']});
  assert.equal(missing.state,'auth-required');
  const unsupported=await inspectRemoteIntegration('tinyfish',{enabled:true,auth:'api-key'});
  assert.equal(unsupported.state,'unsupported');
});
test('real SDK vendor adapter discovers only permitted tools, validates calls and closes',async t=>{
  const root=await mkdtemp(join(await realpath(tmpdir()),'plompy-remote-fixture-'));
  await mkdir(join(root,'secrets'),{mode:0o700});const credentialFile=join(root,'secrets','key');
  await writeFile(credentialFile,'fixture-vendor-key\n',{mode:0o600});
  let calls=0, authorized=0;const servers=new Set();
  const http=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer fixture-vendor-key');authorized++;
    const server=new Server({name:'fixture-vendor',version:'1'},{capabilities:{tools:{}}});servers.add(server);
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
      {name:'perplexity_search',description:'Untrusted provider description',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}},
      {name:'send_email',inputSchema:{type:'object'}},
    ]}));
    server.setRequestHandler(CallToolRequestSchema,async request=>{calls++;assert.equal(request.params.name,'perplexity_search');return {content:[{type:'text',text:'Fixture search results with public sources'}]};});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});await server.connect(transport);await transport.handleRequest(req,res);await server.close();servers.delete(server);
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${http.address().port}`;
  t.after(async()=>{await Promise.allSettled([...servers].map(server=>server.close()));http.closeAllConnections();await new Promise(resolve=>http.close(resolve));await rm(root,{recursive:true,force:true});});
  const registered=[];
  const connection=await connectRemote('perplexity',{enabled:true,auth:'api-key',credentialFile,allowedTools:['perplexity_search']},{registerSecret:secret=>registered.push(secret),fetchImpl:(_url,options)=>safeFetch(origin+'/mcp',{...options,allowHostsForTests:[new URL(origin).host]})});
  try{
    assert.deepEqual(connection.tools.map(tool=>tool.name),['perplexity_perplexity_search']);
    assert.doesNotMatch(connection.tools[0].description,/Untrusted provider description/);
    const result=await connection.tools[0].run({query:'mobile application companies'});assert.match(result.content[0].text,/Fixture search results/);
    await assert.rejects(connection.tools[0].run({query:42}));
    await assert.rejects(connection.tools[0].run({query:'http://169.254.169.254/latest/meta-data'}));
    assert.equal(calls,1);assert.ok(authorized>=3);assert.deepEqual(registered,['fixture-vendor-key']);
  }finally{await connection.close();}
});
