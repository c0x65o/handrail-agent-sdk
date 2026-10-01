import pg from 'pg';
import { createSecretKey, createHash } from 'node:crypto';
import { createAgentStateStore } from 'handrail-agent-sdk/server/postgres';
import { identity } from './host.mjs';
import { conversationHost, scope } from './conversation-host.mjs';
process.once('message',async ({schema,key,effectRef,observation,mode})=>{
  const pool=new pg.Pool({connectionString:process.env.HANDRAIL_TEST_POSTGRES_URL});
  try {
    if(mode==='checkpoint') {
      const secret=createSecretKey(Buffer.from(key,'hex'));
      const states=createAgentStateStore(pool,{current:async()=>({ref:'fixture-key',key:secret}),resolve:async()=>secret},schema,600_000);
      const result=await states.load(identity,{host:identity.host,grantRevision:1,cancellationRevision:0});
      if(!result.ok)throw Error(result.code);
      process.send({digest:createHash('sha256').update(result.value.input).digest('hex'),output:result.value.output});
      return;
    }
    const c=conversationHost(pool,schema,key);
    const applied=await c.work.observe(scope,effectRef,observation);
    process.send({applied,context:await c.context(scope),memory:await c.memory.read(scope,'preference')});
  }catch(e){process.send({error:e.message});}
  finally{await pool.end();process.disconnect();}
});
