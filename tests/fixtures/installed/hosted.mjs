import { createHash, randomUUID } from 'node:crypto';
/** A durable fake of the external hosted service. Scripted inference fixtures
 * run only inside this fake provider; production has no application-run loop. */
export async function hostedBoundary({ pool, schema, identity, model, host, tools }) {
  const table = `"${schema}"."hosted_provider_fixture"`;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, value jsonb NOT NULL)`);
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const get = async id => (await pool.query(`SELECT value FROM ${table} WHERE id=$1`, [id])).rows[0]?.value;
  const put = async (id, value) => { await pool.query(`INSERT INTO ${table}(id,value) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET value=excluded.value`, [id, JSON.stringify(value)]); };
  const sessionId=`fixture-session-${key}`, turnId=`fixture-turn-${key}`;
  const read = () => get(sessionId);
  const page = load => ({ then: (resolve,reject) => load().then(data=>({data})).then(resolve,reject), async *[Symbol.asyncIterator]() { yield* await load(); } });
  const sessions = {
    async create(body) { const value={session:{id:sessionId,metadata:body.metadata,status:'idle',required_actions:[],environment:{type:'openai_hosted',id:`env-${key}`}},history:[],items:[],messages:[],files:[]};await put(sessionId,value);return value.session; },
    async retrieve() { return (await read()).session; },
    list:()=>page(async()=>{const v=await read();return v?[v.session]:[];}),
    async delete() { await pool.query(`DELETE FROM ${table} WHERE id=$1`,[sessionId]); },
    turns:{list:()=>page(async()=>{const v=await read();return v?.turn?[v.turn]:[];}),retrieve:async()=> (await read()).turn,
      items:{list:()=>page(async()=> (await read()).items)}},
    events:{
      async create(_id,body) {
        const value=await read(),event=body.events[0];
        if(event.type==='agent.session.input.message') {
          if(value.messages.includes(body['Idempotency-Key']))return;
          value.messages.push(body['Idempotency-Key']);value.turn={id:turnId,session_id:sessionId,subagent_id:null,status:'running',usage:{input_tokens:0,output_tokens:0,total_tokens:0},completed_at:null};
          value.session.status='running';
          value.history.push(...event.input.filter(i=>!i.content?.[0]?.text?.startsWith('Current application instructions:')));
        } else if(event.type==='agent.session.input.tool_result') {
          const action=value.session.required_actions.find(a=>a.call_id===event.call_id);if(!action)return;
          const out=Array.isArray(event.output)?event.output.map(p=>p.type==='input_text'?p:{type:'input_image',image:p.image_url}):event.output;
          value.history.push({type:'function_call_result',callId:event.call_id,name:action.arguments.name,status:'completed',output:typeof out==='string'?{type:'text',text:out}:out});
          value.session.required_actions=value.session.required_actions.filter(a=>a.call_id!==event.call_id);
          if(!value.session.required_actions.length){value.session.status='running';value.turn.status='running';}
        } else if(event.type==='agent.session.input.computer_use_approval_request_result') {
          value.session.required_actions=value.session.required_actions.filter(a=>a.request_id!==event.request_id);
          value.session.status='running';value.turn.status='running';value.authCompleted=true;
        } else if(event.type==='agent.session.input.cancel') {value.session.status='idle';value.session.required_actions=[];value.turn.status='cancelled';}
        await put(sessionId,value);
      },
      async stream(_id,options) {
        const controller=new AbortController();const signal=AbortSignal.any([controller.signal,options.signal]);
        return {controller,async *[Symbol.asyncIterator]() {
          while(!signal.aborted) {
            let value=await read();if(!value?.turn)return;
            if(value.turn.status==='running' && !value.session.required_actions.length) {
              const visible=host.visibleTools?await host.visibleTools(identity,tools.map(t=>t.name)):tools.map(t=>t.name);
              for await(const event of model.getStreamedResponse({input:value.history,signal,tools:tools.filter(t=>visible.includes(t.name)),authCompleted:value.authCompleted})) {
                if(signal.aborted)throw Error('provider observer aborted');
                if(event.type==='output_text_delta') {
                  yield {type:'agent.session.turn.output_text.delta',event_id:randomUUID(),session_id:sessionId,
                    turn_id:turnId,item_id:'fixture-text',output_index:0,content_index:0,delta:event.delta};
                  continue;
                }
                if(event.type!=='response_done')continue;
                value=await read();if(value.turn.status==='cancelled')break;
                const output=event.response.output;
                value.turn.usage.input_tokens+=event.response.usage?.inputTokens??0;value.turn.usage.output_tokens+=event.response.usage?.outputTokens??0;value.turn.usage.total_tokens+=event.response.usage?.totalTokens??0;
                value.session.required_actions=output.filter(i=>i.type==='function_call').map(i=>({type:'function_call',call_id:i.callId,turn_id:turnId,name:'handrail_call_tool',arguments:{name:i.name,arguments_json:i.arguments}}));
                value.session.required_actions.push(...output.filter(i=>i.type==='computer_use_approval_request').map(i=>({...i,turn_id:turnId})));
                value.history.push(...output.filter(i=>i.type==='function_call'));
                value.items.push(...output.filter(i=>i.type==='message').map((i,n)=>({...i,id:`message-${value.items.length+n}`,phase:'final_answer'})));
                value.turn.status=value.session.required_actions.length?'waiting':'completed';value.session.status=value.session.required_actions.length?'requires_action':'idle';
                if(value.turn.status==='completed')value.turn.completed_at=Math.floor(Date.now()/1000);
                await put(sessionId,value);
              }
            }
            value=await read();
            if(value.session.required_actions.length)yield {type:'agent.session.requires_action',session:value.session};
            else if(['completed','cancelled'].includes(value.turn.status)){yield {type:`agent.session.turn.${value.turn.status}`,turn:value.turn};return;}
          }
        }};
      },
    },
  };
  const files={list:()=>page(async()=> (await read()).files),async create(environmentId,body){
    const value=await read();const file={environment_id:environmentId,path:body.path,size_bytes:Buffer.from(body.data,'base64').length};
    value.files.push(file);await put(sessionId,value);return file;
  }};
  return {client:{beta:{agents:{sessions,environments:{files,retrieve:async()=>({id:`env-${key}`,type:'openai_hosted',status:'connected'})}}}},model:'hosted-fixture',browser:true,
    session:async(_identity,create)=> {let binding=await get(`binding-${key}`)??create(identity.host,key);return {get binding(){return binding;},async save(next){binding=next;await put(`binding-${key}`,binding);}};},
    input:async(_identity,input,signal)=>{const items=typeof input==='string'?[{role:'user',content:[{type:'input_text',text:input}]}]:input;return host.prepareModelInput?host.prepareModelInput(identity,items,signal):items;},
    action:async()=>{throw Error('UNEXPECTED_HOSTED_ACTION');},item:async()=>{},usage:async()=>{},
  };
}
