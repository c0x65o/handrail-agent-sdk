import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import OpenAI from 'openai';
import {createLiveTransportConnector} from '../dist/server/live-transport.js';

async function fixture(t,{status=200,answer='v=0\r\nanswer',rejectSocket=false}={}) {
  const requests=[],messages=[],peers=[];let saved=false;
  const server=createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);
    const body=Buffer.concat(parts).toString();requests.push({path:req.url,headers:req.headers,body:body?JSON.parse(body):null});
    res.setHeader('Content-Type','application/json');
    if(req.url.endsWith('/hangup')){res.end('{}');return;}
    res.statusCode=status;
    res.end(JSON.stringify(status===200?{session:{id:'live_original'},transport:{type:'webrtc',sdp:answer}}:{error:{message:'private provider prompt sk-secret',type:'server_error'}}));
  });
  const sockets=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>{
    assert.equal(saved,true,'provider identity must be persisted before attaching the sideband');
    if(rejectSocket){socket.end('HTTP/1.1 503 Unavailable\r\n\r\n');return;}
    assert.equal(req.headers.authorization,'Bearer fixture-key');
    assert.equal(req.headers['openai-project'],'fixture-project');
    assert.match(req.url,/\/live\/sessions\/live_original\/attach/);
    sockets.handleUpgrade(req,socket,head,peer=>{peers.push(peer);peer.on('message',raw=>messages.push(JSON.parse(String(raw))));});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const peer of peers)peer.terminate();await new Promise(resolve=>sockets.close(resolve));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const client=new OpenAI({apiKey:'fixture-key',project:'fixture-project',baseURL:`http://127.0.0.1:${server.address().port}/v1`,maxRetries:3});
  const connect=createLiveTransportConnector({client,timeoutMs:1000});
  const events=[],disconnections=[];
  const start=(extra={})=>connect({sdp:'v=0\r\noffer',input:[],instructions:'Speak and delegate.',
    onCreated:async id=>{assert.equal(id,'live_original');saved=true;},onEvent:e=>events.push(e),onDisconnect:e=>disconnections.push(e),...extra});
  return {start,requests,messages,events,peers,disconnections};
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Transport event missing');}

test('uses OpenAI session and sideband clients with server-owned delegation and browser event permissions',async t=>{
  const f=await fixture(t);const transport=await f.start();t.after(()=>transport.dispose());
  const request=f.requests[0];assert.equal(request.path,'/v1/live/sessions');
  assert.equal(request.body.session.delegation.type,'client');
  assert.deepEqual(request.body.session.client.data_channel.allowed_client_events,['session.close']);
  assert.equal(request.headers['openai-project'],'fixture-project');
  transport.send({type:'session.thinking.append',delegation_id:null,content:'Saved context'});
  await until(()=>f.messages.length===1);assert.ok(f.messages[0].event_id);
  f.peers[0].send(JSON.stringify({type:'session.input_transcript.delta',event_id:'speech-1',delta:'Hello',start_ms:0,end_ms:20}));
  await until(()=>f.events.length===1);assert.equal(f.events[0].delta,'Hello');
  await transport.hangup();assert.equal(f.requests.at(-1).path,'/v1/live/sessions/live_original/hangup');
});

test('does not retry uncertain creation or expose provider diagnostics',async t=>{
  const f=await fixture(t,{status:500});await assert.rejects(f.start(),error=>{
    assert.equal(error.code,'creation_failed');assert.equal(error.creationOutcome,'uncertain');assert.doesNotMatch(error.message,/private|sk-secret/);return true;
  });
  assert.equal(f.requests.length,1,'client retry configuration is overridden for session creation');
});

test('invalid answer and failed custody end the known original session without another creation',async t=>{
  const f=await fixture(t,{answer:'invalid'});await assert.rejects(f.start(),{code:'invalid_answer'});
  assert.deepEqual(f.requests.map(r=>r.path),['/v1/live/sessions','/v1/live/sessions/live_original/hangup']);
  const g=await fixture(t);await assert.rejects(g.start({onCreated:async()=>{throw Error('Database unavailable');}}),{code:'receipt_failed'});
  assert.deepEqual(g.requests.map(r=>r.path),['/v1/live/sessions','/v1/live/sessions/live_original/hangup']);
});

test('sideband startup rejection cleans up the saved provider session',async t=>{
  const f=await fixture(t,{rejectSocket:true});await assert.rejects(f.start(),{code:'connection_failed'});
  assert.equal(f.requests.at(-1).path,'/v1/live/sessions/live_original/hangup');
});


test('a definitive provider rejection records that no call was created',async t=>{
  for(const status of [400,401,403,404,422]) {
    const f=await fixture(t,{status});
    await assert.rejects(f.start(),error=>{
      assert.equal(error.code,'creation_failed');assert.equal(error.creationOutcome,'not_created');
      assert.doesNotMatch(error.message,/private|sk-secret/);return true;
    });
    assert.equal(f.requests.length,1);
  }
});
