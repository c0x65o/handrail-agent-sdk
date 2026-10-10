import { services, identity } from './host.mjs';
process.once('message',async ({schema,key,mode,approvals})=>{
  let s;
  try {
    s=await services(schema,key,{approvals, ...(approvals==='none'?{host:{decide:undefined}}:{}), afterEffect:mode==='crash'?async()=>{process.send({event:'provider_committed'});await new Promise(()=>{});}:undefined,
      modelHooks:mode==='resume'?{before:async r=>{if(JSON.stringify(r.input).split('Proceed with the approved synthetic item.').length!==2)throw Error('INPUT_NOT_ONCE');}}:undefined,
      state:{approved:true,resolution:{receiptRef:'approved-one',input:'Proceed with the approved synthetic item.'}}});
    if(mode==='resume') {const r=await s.runtime.resume(identity);if(!r.ok)throw Error();}
    const current=await s.journal.load(identity);
    const result=await s.runtime.wake(current.value.identity);process.send(result);
  } catch {process.send({ok:false,code:'CHILD_FAILED'});}
  finally {if(s)await s.close();process.disconnect();}
});
