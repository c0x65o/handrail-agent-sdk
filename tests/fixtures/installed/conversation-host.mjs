import { createSecretKey } from 'node:crypto';
import { createConversation } from 'handrail-agent-sdk/server/conversation';
import { createPostgresConversationStorage } from 'handrail-agent-sdk/server/postgres';
export const scope = {tenantRef:'tenant',userRef:'actor',conversationRef:'continuous'};
export function conversationHost(pool,schema,key,options={}) {
  const secret = createSecretKey(Buffer.from(key,'hex'));
  const storage = createPostgresConversationStorage({client:pool,schema,keys:{current:async()=>({ref:'conversation-key',key:secret}),resolve:async()=>secret},maxRecordBytes:1024*1024});
  return createConversation({storage,authority:{withAccess:async(s,op,run)=>{
    if (options.denied?.(s,op)) throw Error('DENIED'); return run();
  }},now:()=>options.now ?? 100,maxEntryBytes:128_000,maxContextBytes:options.maxContextBytes ?? 3500,pageSize:options.pageSize ?? 8});
}
export const entry = (id,text,role='user') => ({id,items:[{role,content:text}],sourceRefs:[`source:${id}`]});
export const replyModel = (onRequest=()=>{}) => ({
  async getResponse(){throw Error('STREAM_REQUIRED');},
  async *getStreamedResponse(request){
    await onRequest(request);
    yield {type:'response_started'};
    yield {type:'output_text_delta',delta:'Quick answer'};
    yield {type:'response_done',response:{id:'reply',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Quick answer'}]}],usage:{requests:1,inputTokens:10,outputTokens:2,totalTokens:12}}};
  },
});
