import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PostgresAiPersistence, PostgresConversationEventStore, type PostgresSqlClient } from '../assistant/postgres/index.js';
import { replayConversation } from '../assistant/conversation/replay.js';
import type { ConversationId, ConversationClientId } from '../assistant/conversation/events.js';
import { prepareApplicationConversationSubmission, type ApplicationConversationSubmission } from '../assistant/client/session-submission.js';
import type { ChatRequest } from '../assistant/protocol.js';

interface Head { next: number; completed: number; principalId: string; conversationId: string }
interface Entry {
  sequence: number; key: string; content: string; request: ChatRequest; generation: string;
  origin: Readonly<Record<string,string>>;
  submission?: ApplicationConversationSubmission<ChatRequest>;
  status: 'queued' | 'admitted' | 'started' | 'completed' | 'cancelled';
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
        let entry=row.value;
        const turn=entry.submission && replay.state.turns.find(turn=>turn.turn_id===entry.submission!.start.conversationTurnId);
        if(entry.generation!==generation || turn && ['completed','cancelled','failed'].includes(turn.status)) {
          entry={...entry,status:entry.generation!==generation?'cancelled':'completed'};
          await this.#put(p,id,row.version,entry);
          await this.#put(p,'head',head.version,{...head.value,completed:entry.sequence});
          return {pending:entry.sequence<head.value.next};
        }
        if(!entry.submission) {
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
        return {pending:true,submission:entry.submission!};
      } finally {replay.store.destroy();}
    });
    if(!prepared)return {pending:false};
    if('submission' in prepared)await this.options.start(prepared.submission);
    return {pending:prepared.pending};
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
      if(!row.value.submission)return {status:'queued'};
      const replay=await replayConversation({eventStore:new PostgresConversationEventStore(p,this.options.tenantId),
        conversationId:this.options.conversationId as ConversationId,checkpointPolicy:false});
      try {
        const turn=replay.state.turns.find(turn=>turn.turn_id===row.value.submission!.start.conversationTurnId);
        if(!turn)throw new Error('Saved voice turn unavailable');
        const text=replay.state.messages.filter(m=>turn.output_message_ids.includes(m.message_id))
          .flatMap(m=>m.content.map(part=>part.text)).join('\n');
        return {status:turn.status==='completed'?'succeeded':turn.status,text};
      } finally {replay.store.destroy();}
    });
  }
}
