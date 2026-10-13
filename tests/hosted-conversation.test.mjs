import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHostedConversationStore} from '../dist/server/hosted-conversation.js';
import {createHostedSessionClient} from '../dist/server/hosted-session.js';
function fixture(){
 const rows=new Map(); let access=true;
 const store=createHostedConversationStore({authority:{async withAccess(_scope,_op,run){if(!access)throw Error('denied');return run();}},
 storage:{async transaction(scope,run){const key=JSON.stringify(scope);return run({get:async()=>structuredClone(rows.get(key)??null),put:async(_,row)=>{rows.set(key,structuredClone(row));}});}}});
 const driver=createHostedSessionClient({client:{beta:{agents:{sessions:{}}}},model:'test',instructions:'test'});
 return {store,create:driver.binding,scope:{tenantRef:'tenant',userRef:'user',conversationRef:'chat'},revoke:()=>{access=false;}};
}
test('separate process restores original scoped identity and refuses stale writer',async()=>{
 const f=fixture(),one=await f.store.open(f.scope,f.create),two=await f.store.open(f.scope,f.create);
 assert.deepEqual(one.binding,two.binding);
 await one.save({...one.binding,creationAttempted:true,sessionId:'remote'});
 await assert.rejects(two.save({...two.binding,creationAttempted:true}),/WRITE_CONFLICT/);
 const reopened=await f.store.open(f.scope,f.create);assert.equal(reopened.binding.sessionId,'remote');
 await assert.rejects(reopened.save({...reopened.binding,sessionId:'replacement'}),/BINDING_CONFLICT/);
});
test('users and conversations never share provider binding',async()=>{
 const f=fixture(),one=await f.store.open(f.scope,f.create),two=await f.store.open({...f.scope,userRef:'another'},f.create);
 assert.notEqual(one.binding.creationKey,two.binding.creationKey);assert.notEqual(one.binding.scopeDigest,two.binding.scopeDigest);
});
test('revoked conversation authority prevents saved identity writes',async()=>{
 const f=fixture(),one=await f.store.open(f.scope,f.create);f.revoke();
 await assert.rejects(one.save({...one.binding,creationAttempted:true}),/denied/);
});
