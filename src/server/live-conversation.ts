import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PostgresAiPersistence, PostgresConversationEventStore, type PostgresSqlClient } from '../assistant/postgres/index.js';
import { ConversationEventStoreConflictError } from '../assistant/conversation/event-store.js';
import { replayConversation } from '../assistant/conversation/replay.js';
import {parseConversationEvent,type ConversationId,type ConversationClientId} from '../assistant/conversation/events.js';
import { prepareApplicationConversationSubmission, type ApplicationConversationSubmission } from '../assistant/client/session-submission.js';
import type { ChatRequest } from '../assistant/protocol.js';

interface Head { next: number; completed: number; principalId: string; conversationId: string }
interface Entry {
  sequence: number; key: string; content: string; request: ChatRequest; generation: string;
  origin: Readonly<Record<string,string>>;
  submission?: ApplicationConversationSubmission<ChatRequest>;
  status: 'queued' | 'admitted' | 'started' | 'handed_off' | 'completed' | 'cancelled' | 'steering' | 'steered';
  activeInput?: {jobRef:string;turnId:string;receipt?:{turnId:string;messageId:string}};
  deferredFor?: string;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Durable voice ingress into the existing application conversation. Hosts own
 * authentication, immutable request policy, and starting the exact canonical
 * turn through their normal gateway. No credentials or alternate tool loop live
 * here. Hosts wake drain on admission and fresh authenticated recovery traffic.
 * Ending audio must not stop that host-owned conversation worker. */
export class PostgresLiveConversationQueue {
  readonly scopeId: string;
  readonly prefix: string;
  constructor(readonly options: {
    persistence: PostgresAiPersistence; tenantId: string; principalId: string; conversationId: string;
    /** Lock/recheck native ownership and return the current clear-generation.
     * Called inside the same transaction as admission and publication. */
    authorize(sql: PostgresSqlClient): Promise<string>;
    /** Uses the canonical gateway's auth/CSRF/start policy. Replays use the exact
     * saved start, including mutation and idempotency identities. */
    start(submission: ApplicationConversationSubmission<ChatRequest>): Promise<void>;
    now?: () => string;
  }) {
    this.scopeId = options.conversationId;
    this.prefix = `live-input:${hash([options.tenantId, options.principalId, options.conversationId])}:`;
  }
  /** Discovery only. Each returned conversation must pass the same native
   * transaction authorization before any queue content is read or resumed. */
  static async pendingConversations(persistence:PostgresAiPersistence,tenantId:string,principalId:string):Promise<string[]> {
    const rows=await persistence.client.query<{scope_id:string}>(`SELECT DISTINCT scope_id FROM handrail_ai_documents
      WHERE tenant_id=$1 AND kind='checkpoint' AND payload->>'principalId'=$2
        AND payload->>'conversationId'=scope_id AND CASE WHEN jsonb_typeof(payload->'next')='number'
          AND jsonb_typeof(payload->'completed')='number' THEN (payload->>'next')::numeric>(payload->>'completed')::numeric ELSE false END
        AND record_id LIKE 'live-input:%:head' ORDER BY scope_id`,[tenantId,principalId]);
    return rows.rows.map(row=>row.scope_id);
  }
  #id(sequence: number) { return `input:${String(sequence).padStart(16, '0')}`; }
  #get<T>(p: PostgresAiPersistence, id: string) { return p.getDocument<T>(this.options.tenantId, 'checkpoint', this.scopeId, this.prefix+id); }
  #put(p: PostgresAiPersistence, id: string, version: number | null, value: unknown) {
    return p.compareAndSetDocument({tenantId:this.options.tenantId,kind:'checkpoint',scopeId:this.scopeId,
      recordId:this.prefix+id,expectedVersion:version,value});
  }
  async #transaction<T>(work: (p: PostgresAiPersistence, generation: string) => Promise<T>): Promise<T> {
    return this.options.persistence.client.transaction(async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[this.prefix]);
      const generation = await this.options.authorize(sql);
      return work(new PostgresAiPersistence(sql), generation);
    });
  }
  async enqueue(input: { key: string; content: string; request: ChatRequest; origin: Readonly<Record<string,string>>; validateCurrent(): void }): Promise<string> {
    if (!input.key || input.key.length > 512 || !input.content.trim()) throw new TypeError('Invalid saved voice input');
    // Capture mutable caller objects before authorization awaits.
    const retained = JSON.parse(JSON.stringify({ key: input.key, content: input.content, request: input.request, origin: input.origin })) as Pick<Entry,'key'|'content'|'request'|'origin'>;
    const identity = `key:${hash(input.key)}`;
    return this.#transaction(async (p,generation) => {
      const existing = await this.#get<{sequence:number}>(p,identity);
      if (existing) {
        const row=await this.#get<Entry>(p,this.#id(existing.value.sequence));
        if(!row || row.value.generation!==generation || !isDeepStrictEqual(retained,{key:row.value.key,content:row.value.content,request:row.value.request,origin:row.value.origin}))
          throw new Error('Saved voice request identity changed');
        return this.#id(existing.value.sequence);
      }
      const head=await this.#get<Head>(p,'head');
      const sequence=(head?.value.next??0)+1;
      input.validateCurrent();
      await this.#put(p,this.#id(sequence),null,{...retained,generation,sequence,status:'queued'} satisfies Entry);
      await this.#put(p,identity,null,{sequence});
      await this.#put(p,'head',head?.version??null,{next:sequence,completed:head?.value.completed??0,principalId:this.options.principalId,conversationId:this.options.conversationId});
      input.validateCurrent();
      return this.#id(sequence);
    });
  }
  /** One step; the host schedules subsequent steps and retains fresh authority.
   * A concurrent text append conflicts atomically rather than displacing it. */
  async drain(): Promise<{ pending: boolean }> {
    const prepared=await this.#transaction(async (p,generation) => {
      const head=await this.#get<Head>(p,'head');
      if(!head || head.value.completed===head.value.next)return null;
      const id=this.#id(head.value.completed+1),row=await this.#get<Entry>(p,id);
      if(!row)throw new Error('Saved voice queue entry unavailable');
      const events=new PostgresConversationEventStore(p,this.options.tenantId);
      const replay=await replayConversation({eventStore:events,conversationId:this.options.conversationId as ConversationId,checkpointPolicy:false});
      try {
        if(replay.state.replay_error)throw new Error('Saved conversation replay failed');
        let entry=row.value;
        const turnId=entry.submission?.start.conversationTurnId??entry.activeInput?.turnId;
        const turn=turnId?replay.state.turns.find(turn=>turn.turn_id===turnId):undefined;
        const released=['started','steered'].includes(entry.status) && turn?.status==='waiting_for_approval' &&
          !turn.remote_may_still_be_running && replay.state.active_turn_id!==turn.turn_id;
        if(entry.generation!==generation || released || turn && ['completed','cancelled','failed'].includes(turn.status)) {
          // Release ingress ordering, never resolve or cancel the native approval.
          entry={...entry,status:entry.generation!==generation?'cancelled':released?'handed_off':'completed'};
          await this.#put(p,id,row.version,entry);
          await this.#put(p,'head',head.version,{...head.value,completed:entry.sequence});
          return {pending:entry.sequence<head.value.next};
        }
        if(!entry.submission) {
          if(entry.activeInput)return {pending:true};
          if(replay.state.active_turn_id!==null)return {pending:true};
          const submission=prepareApplicationConversationSubmission({conversationId:this.options.conversationId as ConversationId,
            clientId:`live-${hash(this.options.principalId).slice(0,20)}` as ConversationClientId,
            revision:replay.lastRevision??0,operationId:hash([this.scopeId,entry.key]),
            now:this.options.now?.()??new Date().toISOString(),input:{content:entry.content,request:entry.request}});
          await events.append({conversationId:submission.admission.conversationId,expectedRevision:submission.admission.expectedRevision,
            events:submission.admission.mutations.flatMap(m=>m.events)});
          entry={...entry,submission,status:'admitted'};
          await this.#put(p,id,row.version,entry);
          await this.#put(p,`turn:${submission.start.conversationTurnId}`,null,{sequence:entry.sequence});
        }
        return entry.status==='started'?{pending:true}:{pending:true,submission:entry.submission!,id};
      } finally {replay.store.destroy();}
    }).catch(error=>{
      // This append was rolled back before publication. Re-read the new head on
      // the next step; uncertain starts and identity conflicts must propagate.
      if(error instanceof ConversationEventStoreConflictError && error.code==='revision_conflict')return {pending:true};
      throw error;
    });
    if(!prepared)return {pending:false};
    if('submission' in prepared && prepared.submission && prepared.id) {
      const id=prepared.id;
      await this.options.start(prepared.submission);
      await this.#transaction(async(p)=>{
        const row=await this.#get<Entry>(p,id);
        if(!row || !isDeepStrictEqual(row.value.submission,prepared.submission))throw new Error('Saved voice start receipt changed');
        if(row.value.status==='admitted')await this.#put(p,id,row.version,{...row.value,status:'started'});
      });
    }
    return {pending:prepared.pending};
  }
  /** The existing hosted worker consumes current speech in its original turn.
   * The queue is the durable canonical admission; the user message is projected
   * once provider receipt is confirmed. Deferral never duplicates that message.
   * Host policy is structured (for example native speaker/privacy scope), not
   * inferred from speech. The caller must hold the exact native job authority. */
  activeInputs(turnId:string,jobRef:string,accept:(origin:Readonly<Record<string,string>>)=>boolean) {
    if(!turnId||!jobRef)throw new TypeError('Active voice input identity required');
    const next=()=>this.#transaction(async(p,generation)=>{
      const replay=await replayConversation({eventStore:new PostgresConversationEventStore(p,this.options.tenantId),
        conversationId:this.options.conversationId as ConversationId,checkpointPolicy:false});
      try {
        if(replay.state.replay_error)throw new Error('Saved conversation replay failed');
        if(replay.state.active_turn_id!==turnId)return null;
        const head=await this.#get<Head>(p,'head');
        if(!head)return null;
        for(let sequence=head.value.completed+1;sequence<=head.value.next;sequence++) {
          const id=this.#id(sequence),row=await this.#get<Entry>(p,id);
          if(!row)throw new Error('Saved voice queue entry unavailable');
          const entry=row.value;
          if(entry.generation!==generation)return null;
          if(entry.submission?.start.conversationTurnId===turnId || entry.status==='steered')continue;
          if(entry.activeInput?.jobRef===jobRef && entry.activeInput.turnId===turnId && entry.status==='steering')
            return {key:id,messages:[{role:'user' as const,content:[{type:'input_text' as const,text:entry.content}]}]};
          if(entry.status!=='queued'||entry.activeInput||entry.deferredFor===jobRef||!accept(entry.origin))return null;
          await this.#put(p,id,row.version,{...entry,status:'steering',activeInput:{jobRef,turnId}} satisfies Entry);
          return {key:id,messages:[{role:'user' as const,content:[{type:'input_text' as const,text:entry.content}]}]};
        }
        return null;
      }finally{replay.store.destroy();}
    });
    const update=(key:string,receipt?:{turnId:string;messageId:string})=>this.#transaction(async(p,generation)=>{
      const row=await this.#get<Entry>(p,key),entry=row?.value;
      if(!row||!entry||entry.generation!==generation)throw new Error('Saved voice input is no longer current');
      if(!receipt&&entry.deferredFor===jobRef&&entry.status==='queued')return;
      if(entry.activeInput?.jobRef!==jobRef||entry.activeInput.turnId!==turnId)throw new Error('Active voice input identity changed');
      if(receipt) {
        if(entry.activeInput.receipt) {
          if(!isDeepStrictEqual(entry.activeInput.receipt,receipt))throw new Error('Active voice receipt changed');
          return;
        }
        if(entry.status!=='steering'||!receipt.messageId||!receipt.turnId)throw new Error('Active voice receipt unavailable');
        const events=new PostgresConversationEventStore(p,this.options.tenantId);
        const revision=await events.getLatestRevision(this.options.conversationId as ConversationId);
        const id=hash([this.prefix,key]);
        await events.append({conversationId:this.options.conversationId as ConversationId,expectedRevision:revision,
          events:[parseConversationEvent({version:1,event_id:`live-input-${id}`,conversation_id:this.options.conversationId,
            revision:(revision??0)+1,occurred_at:this.options.now?.()??new Date().toISOString(),
            actor:{type:'user'},source:{type:'client',client_id:`live-${hash(this.options.principalId).slice(0,20)}`},
            metadata:{live_input:{turn_id:turnId,call_id:entry.origin.callId??null}},
            payload:{type:'message.created',message_id:`live-message-${id}`,role:'user',content:[{type:'text',text:entry.content}]}})]});
        await this.#put(p,key,row.version,{...entry,status:'steered',activeInput:{...entry.activeInput,receipt}} satisfies Entry);
      } else {
        if(entry.status!=='steering'||entry.activeInput.receipt)throw new Error('Received voice input cannot be deferred');
        const {activeInput:_active,...rest}=entry;
        await this.#put(p,key,row.version,{...rest,status:'queued',deferredFor:jobRef} satisfies Entry);
      }
    });
    return {next,received:(key:string,receipt:{turnId:string;messageId:string})=>update(key,receipt),defer:(key:string)=>update(key)};
  }
  /** All native speech attached to this work, including corrections received
   * during execution. Hosts use these records for call activity provenance. */
  async inputOrigins(turnId:string):Promise<Readonly<Record<string,string>>[]> {
    return this.#transaction(async(p,generation)=>{
      const rows=await p.client.query<{payload:Entry}>(`SELECT payload FROM handrail_ai_documents
        WHERE tenant_id=$1 AND kind='checkpoint' AND scope_id=$2 AND record_id LIKE $3`,
      [this.options.tenantId,this.scopeId,`${this.prefix}input:%`]);
      return rows.rows.map(row=>row.payload).filter(entry=>entry.generation===generation&&
        (entry.submission?.start.conversationTurnId===turnId||entry.activeInput?.turnId===turnId&&entry.activeInput.receipt))
        .map(entry=>entry.origin);
    });
  }
  /** Native hosts consult this binding when building tool/privacy policy. A
   * browser or model metadata claim cannot create this trusted queue record. */
  async turnOrigin(turnId: string): Promise<{origin:Readonly<Record<string,string>>;submission:ApplicationConversationSubmission<ChatRequest>} | null> {
    return this.#transaction(async(p,generation)=>{
      const ref=await this.#get<{sequence:number}>(p,`turn:${turnId}`);
      if(!ref)return null;
      const row=await this.#get<Entry>(p,this.#id(ref.value.sequence));
      if(!row?.value.submission || row.value.generation!==generation)throw new Error('Saved voice origin is no longer current');
      return {origin:row.value.origin,submission:row.value.submission};
    });
  }
  async read(id: string): Promise<{ status: string; text?: string }> {
    return this.#transaction(async(p,generation)=>{
      const row=await this.#get<Entry>(p,id);
      if(!row)throw new Error('Saved voice request unavailable');
      if(row.value.generation!==generation || row.value.status==='cancelled')return {status:'cancelled'};
      const turnId=row.value.submission?.start.conversationTurnId??row.value.activeInput?.turnId;
      if(!turnId)return {status:'queued'};
      const replay=await replayConversation({eventStore:new PostgresConversationEventStore(p,this.options.tenantId),
        conversationId:this.options.conversationId as ConversationId,checkpointPolicy:false});
      try {
        if(replay.state.replay_error)throw new Error('Saved conversation replay failed');
        const turn=replay.state.turns.find(turn=>turn.turn_id===turnId);
        if(!turn)throw new Error('Saved voice turn unavailable');
        if(row.value.status==='steering'&&!['completed','cancelled','failed'].includes(turn.status))return {status:'queued'};
        const text=replay.state.messages.filter(m=>turn.output_message_ids.includes(m.message_id))
          .flatMap(m=>m.content.map(part=>part.text)).join('\n');
        return {status:turn.status==='completed'?'succeeded':turn.status,text};
      } finally {replay.store.destroy();}
    });
  }
}
