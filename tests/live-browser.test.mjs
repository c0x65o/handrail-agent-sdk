import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserLiveCall, LiveOutputPlayback, addLiveCaption, groupLiveCaptions } from '../dist/assistant/browser/live-voice.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(check) { for(let i=0;i<100;i++){if(check())return;await pause(2);}assert.fail('Browser state did not settle'); }
class Track extends EventTarget { enabled=true; muted=false; kind='audio'; readyState='live'; stops=0; stop(){this.stops++;this.readyState='ended';} }
class Channel extends EventTarget {
  readyState='open'; sent=[];
  send(value){this.sent.push(JSON.parse(value));}
  close(){this.readyState='closed';this.dispatchEvent(new Event('close'));}
  event(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
}
class Peer extends EventTarget {
  connectionState='new';iceGatheringState='complete';channel=new Channel();tracks=[];closed=false;started=true;
  addTrack(track){this.tracks.push(track);}
  createDataChannel(){return this.channel;}
  async createOffer(){return {type:'offer',sdp:'v=0\r\noffer'};}
  async setLocalDescription(description){this.localDescription=description;}
  async setRemoteDescription(description){this.remoteDescription=description;if(this.started)this.channel.event({type:'session.started',session:{id:'live_original'}});}
  close(){this.closed=true;this.connectionState='closed';this.dispatchEvent(new Event('connectionstatechange'));}
}
function fixture(t,overrides={}){
  const track=new Track(),peer=new Peer(),states=[],exchanges=[],ends=[];
  const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const audio={srcObject:null,autoplay:false,paused:true,async play(){this.paused=false;},pause(){this.paused=true;}};
  const call=new BrowserLiveCall({id:'original-call-id',createPeer:()=>peer,microphone:async()=>stream,createAudio:()=>audio,
    exchange:async input=>{exchanges.push(input);return {sdp:'v=0\r\nanswer'};},
    end:async id=>{ends.push(id);return {confirmed:true};},onChange:state=>states.push(state),...overrides});
  t.after(()=>call.dispose());
  return {call,track,peer,stream,audio,states,exchanges,ends};
}

test('keeps microphone disabled until provider startup, supports mute and immediate stop',async t=>{
  const f=fixture(t);f.peer.started=false;const starting=f.call.start();
  await until(()=>f.peer.remoteDescription);assert.equal(f.track.enabled,false);assert.equal(f.call.getSnapshot().status,'starting');
  f.peer.channel.event({type:'session.started',session:{id:'live_original'}});await starting;
  assert.equal(f.call.getSnapshot().status,'connected');assert.equal(f.track.enabled,true);assert.equal(f.call.getSnapshot().listening,true);
  f.call.mute();assert.equal(f.track.enabled,false);assert.equal(f.call.getSnapshot().listening,false);
  f.call.mute();assert.equal(f.track.enabled,true);
  await f.call.stop();assert.equal(f.track.readyState,'ended');assert.equal(f.peer.closed,true);
  assert.equal(f.call.getSnapshot().status,'closed');assert.deepEqual(f.ends,['original-call-id']);
});

test('stopping during a permission prompt releases the late microphone without creating a call',async t=>{
  const media=deferred();const f=fixture(t,{microphone:()=>media.promise});const starting=f.call.start();
  await f.call.stop();media.resolve(f.stream);await starting;
  assert.equal(f.track.readyState,'ended');assert.equal(f.exchanges.length,0);assert.equal(f.ends.length,0);
});

test('ending pending startup uses the original admission identity and never retries creation',async t=>{
  const exchange=deferred();let exchanges=0;const f=fixture(t,{exchange:()=>{exchanges++;return exchange.promise;}});
  const starting=f.call.start();await until(()=>exchanges===1);
  await f.call.stop();exchange.resolve({sdp:'v=0\r\nanswer'});await starting;
  await f.call.start();assert.equal(exchanges,1);assert.deepEqual(f.ends,['original-call-id']);
  assert.equal(f.peer.remoteDescription,undefined);assert.equal(f.track.readyState,'ended');
});

test('lost end receipt is visible and retry ends the same call without creating another',async t=>{
  let attempts=0;const f=fixture(t,{end:async id=>{assert.equal(id,'original-call-id');attempts++;return {confirmed:attempts>1};}});
  await f.call.start();await f.call.stop();
  assert.equal(f.call.getSnapshot().status,'end_unconfirmed');assert.equal(f.track.readyState,'ended');
  assert.deepEqual(f.peer.channel.sent,[{type:'session.close'}]);
  await f.call.stop();assert.equal(f.call.getSnapshot().status,'closed');assert.equal(attempts,2);assert.equal(f.exchanges.length,1);assert.equal(f.call.getSnapshot().error,null);
});

test('autoplay blocking remains actionable and device disconnection stops audio',async t=>{
  const f=fixture(t);await f.call.start();
  const remote=new Track();const event=new Event('track');event.track=remote;event.streams=[{getTracks:()=>[remote]}];
  f.audio.play=async()=>{throw Error('Blocked');};f.peer.dispatchEvent(event);
  await until(()=>f.call.getSnapshot().playbackBlocked);
  f.audio.play=async()=>{f.audio.paused=false;};await f.call.play();assert.equal(f.call.getSnapshot().playbackBlocked,false);
  f.track.dispatchEvent(new Event('ended'));await until(()=>f.call.getSnapshot().status==='closed');
  assert.equal(remote.readyState,'ended');assert.equal(f.audio.paused,true);assert.equal(f.audio.srcObject,null);
});

test('provider identity mismatch closes the original call and sanitizes errors',async t=>{
  const f=fixture(t);await f.call.start();
  f.peer.channel.event({type:'session.started',session:{id:'private-wrong-id'}});
  await until(()=>f.call.getSnapshot().status==='closed');
  assert.doesNotMatch(f.call.getSnapshot().error,/private-wrong-id/);assert.deepEqual(f.ends,['original-call-id']);
});

test('caption display deduplicates, orders and groups without mutating input',()=>{
  const input={type:'session.input_transcript.delta',event_id:'first',delta:'Hello ',start_ms:0,end_ms:10};
  const first=addLiveCaption([],input);assert.equal(addLiveCaption(first,input),first);
  const second=addLiveCaption(first,{...input,event_id:'second',delta:'world',start_ms:11,end_ms:20});
  assert.equal(groupLiveCaptions(second)[0].text,'Hello world');assert.equal(second[0].text,'Hello ');
  assert.equal(addLiveCaption(second,{...input,event_id:'bad',start_ms:-1}),second);
});

test('leaving the page stops capture and requests the original durable call end',async t=>{
  const lifecycle=new EventTarget();const f=fixture(t,{lifecycle});await f.call.start();
  lifecycle.dispatchEvent(new Event('pagehide'));await until(()=>f.call.getSnapshot().status==='closed');
  assert.equal(f.track.readyState,'ended');assert.deepEqual(f.ends,['original-call-id']);
});

test('speaking indication requires advancing audible local playout and expires on stale samples',()=>{
  const playback=new LiveOutputPlayback();
  const reports=(energy,duration,played)=>[{id:'in',type:'inbound-rtp',kind:'audio',trackIdentifier:'remote',playoutId:'out',totalAudioEnergy:energy,totalSamplesDuration:duration},
    {id:'out',type:'media-playout',kind:'audio',totalSamplesDuration:played}];
  playback.observe(reports(1,1,1),{trackIds:['remote'],now:1000});assert.equal(playback.isSpeaking(1000),false);
  playback.observe(reports(2,2,1),{trackIds:['remote'],now:1100});assert.equal(playback.isSpeaking(1100),false);
  playback.observe(reports(3,3,2),{trackIds:['remote'],now:1200});assert.equal(playback.isSpeaking(1200),true);
  playback.observe(reports(3,3,2),{trackIds:['remote'],now:1801});assert.equal(playback.isSpeaking(1801),false);
  playback.reset();assert.equal(playback.isSpeaking(1200),false);
});
