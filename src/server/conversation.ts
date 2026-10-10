import { createHash } from 'node:crypto';
import { MemorySession, OpenAIResponsesCompactionSession, setSensitiveDataLoggingEnabled } from '@openai/agents';
import type { AgentInputItem, Session } from '@openai/agents';
import { validEffectRequest } from './effects.js';
import type { EffectAdapter, EffectRequest } from './effects.js';
import { createAgentRuntime } from './agent-runtime.js';
import type { JobIdentity } from '../contracts/job.js';
import { canonicalAgentJson } from './agent-state-binding.js';

/** Trusted server identity. A user scope (no conversationRef) is only for memory. */
export interface ConversationScope { tenantRef: string; userRef: string; conversationRef?: string }
export type ConversationOperation = 'read' | 'append' | 'context' | 'memory_read' | 'memory_write' | 'delegate' | 'callback';
export interface ConversationAuthority {
  /** Derive scope on server; keep current permission valid through the callback.
   * Memory, transcript text and model decisions never supply permission. */
  withAccess<T>(scope: ConversationScope, operation: ConversationOperation, run: () => Promise<T>): Promise<T>;
}
export interface ConversationRecord { id: string; revision: number; order: number; active?: boolean; value: unknown }
export type ConversationCollection = 'transcript' | 'state' | 'pins' | 'memory' | 'memory_history' | 'work';
export interface ConversationTransaction {
  get(collection: ConversationCollection, id: string): Promise<ConversationRecord | null>;
  page(collection: ConversationCollection, options: { after?: number; before?: number; limit: number; reverse?: boolean; activeOnly?: boolean }): Promise<ConversationRecord[]>;
  /** Called under the scope transaction lock; replace only this record. */
  put(collection: ConversationCollection, record: ConversationRecord): Promise<void>;
}
export interface ConversationStorage {
  /** Atomic, isolated across processes, rollback on throw; no network effects inside. */
  transaction<T>(scope: ConversationScope, run: (tx: ConversationTransaction) => Promise<T>): Promise<T>;
}
export interface TranscriptEntry {
  id: string;
  /** Whole replayable turn/batch. Never split tool calls from their results. */
  items: AgentInputItem[];
  sourceRefs: string[];
  /** Optional host-verified output receipt, retained for crash recovery. */
  receiptRef?: string;
}
export interface MemoryValue {
  text: string;
  provenance: { sourceRef: string; role: 'user' | 'assistant' | 'tool' | 'host'; observedAt: number }[];
  /** Null means lasting memory. Expired entries are returned explicitly as stale. */
  validUntil: number | null;
  /** Host-defined display/scope metadata. It never grants runtime authority. */
  metadata?: Record<string, unknown>;
}
export interface MemoryRecord { id: string; revision: number; status: 'active' | 'forgotten'; value?: MemoryValue; stale: boolean }
export interface WorkBinding {
  /** Original durable effect identity, never regenerated on retry. */
  effect: EffectRequest;
  originEntryId: string;
  instructionRevision: number;
}
export interface WorkObservation {
  revision: number;
  instructionRevision: number;
  status: 'active' | 'paused' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  /** Host-verified native receipt/question/approval identities. */
  reference: string;
  result?: TranscriptEntry;
}
interface WorkRecord { binding: WorkBinding; observation?: WorkObservation }
const digest = (v: unknown) => createHash('sha256').update(canonicalAgentJson(v)).digest('hex');
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const equal = (a: unknown, b: unknown) => canonicalAgentJson(a) === canonicalAgentJson(b);
const ref = (s: string) => { if (typeof s !== 'string' || !s.length || s.length > 256) throw Error('CONVERSATION_REFERENCE_INVALID'); };
function scopeCheck(s: ConversationScope) { ref(s.tenantRef); ref(s.userRef); if (s.conversationRef !== undefined) ref(s.conversationRef); }
function normalizedScope(scope: ConversationScope): ConversationScope {
  scopeCheck(scope);
  return {tenantRef:scope.tenantRef,userRef:scope.userRef,
    ...(scope.conversationRef === undefined ? {} : {conversationRef:scope.conversationRef})};
}
const conversation = (s: ConversationScope) => { if (!s.conversationRef) throw Error('CONVERSATION_REQUIRED'); };
const positive = (n: number) => { if (!Number.isSafeInteger(n) || n < 1) throw Error('CONVERSATION_LIMIT_INVALID'); };

/** Host-canonical transcript, bounded model view, scoped memory and work-return
 * bindings. No scheduler, model loop, intent classifier or outcome controller. */
export function createConversation(deps: { storage: ConversationStorage; authority: ConversationAuthority; now: () => number;
  maxEntryBytes: number; maxContextBytes: number; pageSize: number }) {
  setSensitiveDataLoggingEnabled(false);
  [deps.maxEntryBytes, deps.maxContextBytes, deps.pageSize].forEach(positive);
  const access = <T>(scope: ConversationScope, op: ConversationOperation, run: (tx: ConversationTransaction) => Promise<T>) => {
    scope = normalizedScope(scope);
    return deps.authority.withAccess(scope, op, () => deps.storage.transaction(scope, run));
  };
  const entryCheck = (entry: TranscriptEntry) => {
    ref(entry.id); entry.sourceRefs.forEach(ref);
    if (!Array.isArray(entry.items) || !entry.items.length || bytes(entry) > deps.maxEntryBytes) throw Error('CONVERSATION_ENTRY_LIMIT');
  };
  async function changed(tx: ConversationTransaction) {
    const current = await tx.get('state','context-revision');
    const revision = (current?.revision ?? 0)+1;
    await tx.put('state',{id:'context-revision',revision,order:revision,value:null});
  }
  async function append(tx: ConversationTransaction, entry: TranscriptEntry) {
    entryCheck(entry);
    const old = await tx.get('transcript', entry.id);
    if (old) { if (!equal(old.value, entry)) throw Error('CONVERSATION_ID_CONFLICT'); return old.order; }
    const head = await tx.get('state', 'head');
    const order = (head?.order ?? 0) + 1;
    await tx.put('transcript', { id: entry.id, revision: 1, order, value: entry });
    await tx.put('state', { id: 'head', revision: order, order, value: null });
    await changed(tx);
    return order;
  }
  const memoryVersionId=(id:string,revision:number)=>digest([id,revision]);
  const memoryView=(row:ConversationRecord,id:string):MemoryRecord=>{
    const saved=row.value as {status:'active'|'forgotten';value?:MemoryValue};
    return {id,revision:row.revision,...saved,stale:Boolean(saved.value&&saved.value.validUntil!==null&&saved.value.validUntil<=deps.now())};
  };
  return {
    append(scope: ConversationScope, input: TranscriptEntry) {
      conversation(scope); const entry = structuredClone(input);
      return access(scope, 'append', tx => append(tx, entry));
    },
    readEntry(scope: ConversationScope, id: string) {
      conversation(scope); ref(id);
      return access(scope, 'read', async tx => (await tx.get('transcript', id))?.value as TranscriptEntry | undefined);
    },
    read(scope: ConversationScope, after = 0, limit = deps.pageSize) {
      conversation(scope); positive(limit); if (limit > deps.pageSize || !Number.isSafeInteger(after) || after < 0) throw Error('CONVERSATION_PAGE_LIMIT');
      return access(scope, 'read', async tx => {
        const rows = await tx.page('transcript', { after, limit: limit + 1 });
        return { entries: rows.slice(0, limit).map(r => ({ sequence: r.order, entry: r.value as TranscriptEntry })),
          next: rows.length > limit ? rows[limit - 1]!.order : null };
      });
    },
    /** Explicit trusted classification of corrections/obligations/approvals.
     * Each active pin retains its original role and exact canonical entry. */
    pin(scope: ConversationScope, id: string, expectedRevision: number, entryId: string | null) {
      conversation(scope); ref(id);
      return access(scope, 'context', async tx => {
        const old = await tx.get('pins', id);
        if ((old?.revision ?? 0) !== expectedRevision) throw Error('CONVERSATION_REVISION_CONFLICT');
        if (entryId !== null && !await tx.get('transcript', entryId)) throw Error('CONVERSATION_SOURCE_MISSING');
        await tx.put('pins', { id, revision: expectedRevision + 1, order: expectedRevision + 1, active: entryId !== null, value: entryId });
        await changed(tx);
        return expectedRevision + 1;
      });
    },
    /** Persist an upstream-produced compacted view with a snapshot CAS. Never
     * overwrites the canonical transcript or active exact-source pins. */
    compact(scope: ConversationScope, expectedRevision: number, items: AgentInputItem[]) {
      conversation(scope); const compacted = structuredClone(items);
      if (bytes(compacted) > deps.maxContextBytes) throw Error('CONVERSATION_CONTEXT_CAPACITY');
      return access(scope, 'context', async tx => {
        const head = (await tx.get('state','head'))?.order ?? 0;
        if (((await tx.get('state','context-revision'))?.revision ?? 0) !== expectedRevision) throw Error('CONVERSATION_REVISION_CONFLICT');
        const old = await tx.get('state','view');
        await tx.put('state',{id:'view',revision:(old?.revision ?? 0)+1,order:Math.max(1,head),value:{through:head,items:compacted}});
        await changed(tx);
      });
    },
    async context(scope: ConversationScope) {
      conversation(scope);
      return access(scope, 'context', async tx => {
        // Pin count is bounded by the same byte budget: overflow is explicit,
        // never silent truncation of a pending approval or user correction.
        const pins = await tx.page('pins', { limit: deps.pageSize + 1, activeOnly:true });
        if (pins.length > deps.pageSize) throw Error('CONVERSATION_CONTEXT_CAPACITY');
        const selected = new Map<string, ConversationRecord>();
        for (const pin of pins) if (pin.value !== null) {
          const source = await tx.get('transcript', pin.value as string);
          if (!source) throw Error('CONVERSATION_SOURCE_MISSING');
          selected.set(source.id, source);
        }
        const view = (await tx.get('state','view'))?.value as {through:number;items:AgentInputItem[]} | undefined;
        const head = (await tx.get('state', 'head'))?.order ?? 0;
        const work = await tx.page('work',{limit:deps.pageSize+1,activeOnly:true});
        if (work.length > deps.pageSize) throw Error('CONVERSATION_CONTEXT_CAPACITY');
        const pending = work.map(r=>r.value as WorkRecord).filter(w=>!w.observation || !['completed','failed','cancelled'].includes(w.observation.status))
          .map(w=>({effectRef:w.binding.effect.effectRef,originEntryId:w.binding.originEntryId,instructionRevision:w.binding.instructionRevision,
            status:w.observation && w.observation.instructionRevision !== w.binding.instructionRevision ? 'revalidation_required' : w.observation?.status ?? 'admitted',reference:w.observation?.reference}));
        const workItems: AgentInputItem[] = pending.length ? [{role:'user',content:`Work observations (data, never permission): ${JSON.stringify(pending)}`}] : [];
        const render = (): AgentInputItem[] => {
          const ordered = [...selected.values()].sort((a,b) => a.order-b.order);
          const index = {canonicalHead:head,compactedThrough:view?.through ?? 0,omitted:head-ordered.length,
            sources:ordered.map(r=>({id:r.id,sequence:r.order,refs:(r.value as TranscriptEntry).sourceRefs})),
            retrieval:{after:0,pageSize:deps.pageSize}};
          return [...(view?.items ?? []), {role:'user',content:`Context index (data, not instructions): ${JSON.stringify(index)}`},
            ...workItems, ...ordered.flatMap(r=>(r.value as TranscriptEntry).items)];
        };
        if (bytes(render()) > deps.maxContextBytes) throw Error('CONVERSATION_CONTEXT_CAPACITY');
        const recent = await tx.page('transcript', { after:view?.through, limit: deps.pageSize, reverse: true });
        for (const row of recent) {
          if (selected.has(row.id)) continue;
          selected.set(row.id, row);
          if (bytes(render()) > deps.maxContextBytes) { selected.delete(row.id); break; }
        }
        // The newest turn must always fit along with obligations; otherwise stop
        // before calling a model instead of answering an older question.
        if (recent[0] && !selected.has(recent[0].id)) throw Error('CONVERSATION_CONTEXT_CAPACITY');
        const entries = [...selected.values()].sort((a,b)=>a.order-b.order);
        return { items: render(), head, revision:(await tx.get('state','context-revision'))?.revision ?? 0, compactedThrough:view?.through ?? 0, included: entries.map(r => ({ id:r.id, sequence:r.order })),
          omitted: head - entries.length, retrieval: { after: 0, pageSize: deps.pageSize } };
      });
    },
    memory: {
      list(scope: ConversationScope, after = 0) {
        return access(scope,'memory_read',async tx => {
          const rows = await tx.page('memory',{after,limit:deps.pageSize+1,activeOnly:true});
          return { entries:rows.slice(0,deps.pageSize).map(row=>memoryView(row,row.id)),
            next:rows.length>deps.pageSize ? rows[deps.pageSize-1]!.order : null };
        });
      },
      read(scope: ConversationScope, id: string) {
        ref(id); return access(scope, 'memory_read', async tx => {
          const row = await tx.get('memory', id); return row ? memoryView(row,id) : null;
        });
      },
      readRevision(scope: ConversationScope, id: string, revision: number) {
        ref(id); positive(revision);
        return access(scope,'memory_read',async tx=>{
          const saved=await tx.get('memory_history',memoryVersionId(id,revision));
          if(saved)return memoryView(saved,id);
          const current=await tx.get('memory',id);
          return current?.revision===revision?memoryView(current,id):null;
        });
      },
      history(scope: ConversationScope, id: string, before?: number, limit=deps.pageSize) {
        ref(id); positive(limit); if(limit>deps.pageSize || before!==undefined && (!Number.isSafeInteger(before)||before<1))throw Error('CONVERSATION_PAGE_LIMIT');
        return access(scope,'memory_read',async tx=>{
          const current=await tx.get('memory',id);
          const start=Math.min(before===undefined?Number.MAX_SAFE_INTEGER:before-1,current?.revision??0);
          const end=Math.max(1,start-limit+1),entries:MemoryRecord[]=[],unavailableRevisions:number[]=[];
          for(let revision=start;revision>=end;revision--){
            const row=await tx.get('memory_history',memoryVersionId(id,revision)) || (current?.revision===revision?current:null);
            if(row)entries.push(memoryView(row,id));else unavailableRevisions.push(revision);
          }
          return {entries,unavailableRevisions,next:start>0&&end>1?end:null};
        });
      },
      revise(scope: ConversationScope, id: string, expectedRevision: number, input: MemoryValue | null) {
        ref(id); const value = structuredClone(input);
        if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)throw Error('MEMORY_REVISION_CONFLICT');
        if (value && (!value.text || !value.provenance.length || value.validUntil!==null&&!Number.isSafeInteger(value.validUntil)
          || value.metadata!==undefined&&(!value.metadata||typeof value.metadata!=='object'||Array.isArray(value.metadata))
          || value.provenance.some(p => !p.sourceRef || !['user','assistant','tool','host'].includes(p.role) || !Number.isSafeInteger(p.observedAt))
          || bytes(value) > deps.maxEntryBytes)) throw Error('MEMORY_VALUE_INVALID');
        return access(scope, 'memory_write', async tx => {
          const old = await tx.get('memory', id);
          if ((old?.revision ?? 0) !== expectedRevision) throw Error('MEMORY_REVISION_CONFLICT');
          // Retain the existing current revision when upgrading from a store
          // written before history support. Missing older history stays explicit.
          if(old&&!await tx.get('memory_history',memoryVersionId(id,old.revision)))
            await tx.put('memory_history',{...old,id:memoryVersionId(id,old.revision)});
          // Forget erases all retained value payloads, including history. Archive
          // is an application metadata state when historical values should remain.
          if(value===null)for(let revision=expectedRevision;revision>0;revision--){
            const saved=await tx.get('memory_history',memoryVersionId(id,revision));
            if(saved)await tx.put('memory_history',{...saved,active:false,value:{status:'forgotten'}});
          }
          const head = await tx.get('state','memory-head'), order = (head?.order ?? 0)+1;
          const record={id,revision:expectedRevision+1,order,active:value!==null,
            value:value?{status:'active',value}:{status:'forgotten'}};
          await tx.put('state',{id:'memory-head',revision:order,order,value:null});
          await tx.put('memory_history',{...record,id:memoryVersionId(id,record.revision)});
          await tx.put('memory',record);
          return record.revision;
        });
      },
    },
    work: {
      bind(scope: ConversationScope, input: WorkBinding) {
        scope = normalizedScope(scope); conversation(scope); const binding = structuredClone(input);
        if (!validEffectRequest(binding.effect)) throw Error('WORK_BINDING_INVALID');
        return access(scope, 'delegate', async tx => {
          if (binding.effect.identity.host.tenantRef !== scope.tenantRef || binding.effect.identity.host.userRef !== scope.userRef
            || binding.instructionRevision !== binding.effect.identity.instructionRevision) throw Error('WORK_SCOPE_CONFLICT');
          if (!await tx.get('transcript', binding.originEntryId)) throw Error('CONVERSATION_SOURCE_MISSING');
          const id = binding.effect.effectRef, old = await tx.get('work', id);
          if (old) { if (!equal((old.value as WorkRecord).binding, binding)) throw Error('WORK_BINDING_CONFLICT'); return; }
          await tx.put('work', { id, revision: 1, order: 1, value: { binding } });
          await tx.put('pins',{id:`work:${id}`,revision:1,order:1,value:binding.originEntryId});
          await changed(tx);
        });
      },
      read(scope: ConversationScope, id: string) {
        conversation(scope); return access(scope, 'read', async tx => { const row=await tx.get('work',id); return row ? {...row.value as WorkRecord,revision:row.revision} : undefined; });
      },
      /** Correction invalidates older callbacks while preserving native/effect IDs.
       * Host pauses/revalidates native execution before invoking this operation. */
      correct(scope: ConversationScope, id: string, expectedRevision: number, instructionRevision: number) {
        conversation(scope); positive(instructionRevision);
        return access(scope,'delegate',async tx => {
          const row = await tx.get('work',id); if (!row || row.revision !== expectedRevision) throw Error('WORK_REVISION_CONFLICT');
          const work = row.value as WorkRecord;
          if (instructionRevision <= work.binding.instructionRevision || (work.observation && ['completed','failed','cancelled'].includes(work.observation.status))) throw Error('WORK_INSTRUCTION_CONFLICT');
          await tx.put('work',{...row,revision:row.revision+1,value:{...work,binding:{...work.binding,instructionRevision}}});
          await changed(tx);
        });
      },
      observe(scope: ConversationScope, id: string, input: WorkObservation) {
        conversation(scope); const observation = structuredClone(input); positive(observation.revision); ref(observation.reference);
        if (!['active','paused','waiting','completed','failed','cancelled'].includes(observation.status)) throw Error('WORK_STATUS_INVALID');
        return access(scope, 'callback', async tx => {
          const old = await tx.get('work', id); if (!old) throw Error('WORK_BINDING_MISSING');
          const work = old.value as WorkRecord;
          if (observation.instructionRevision !== work.binding.instructionRevision) throw Error('WORK_INSTRUCTION_CONFLICT');
          const prior = work.observation;
          if (prior && observation.revision < prior.revision) return 'stale' as const;
          if (prior && observation.revision === prior.revision) {
            if (!equal(prior, observation)) throw Error('WORK_CALLBACK_CONFLICT'); return 'duplicate' as const;
          }
          if (prior && ['completed','failed','cancelled'].includes(prior.status)) throw Error('WORK_TERMINAL_CONFLICT');
          if ((observation.status === 'completed') !== !!observation.result) throw Error('WORK_RESULT_REQUIRED');
          if (observation.result) {
            entryCheck(observation.result);
            // Original effect identity owns delivery, regardless of callback ID.
            await append(tx, { ...observation.result, id: `work:${digest(work.binding.effect)}`,
              sourceRefs:[...new Set([...observation.result.sourceRefs,work.binding.originEntryId,observation.reference])] });
          }
          const terminal = ['completed','failed','cancelled'].includes(observation.status);
          await tx.put('work', { ...old, revision: old.revision + 1, active:!terminal, value: { ...work, observation } });
          if (terminal) {
            const pin = await tx.get('pins',`work:${id}`);
            if (pin) await tx.put('pins',{...pin,revision:pin.revision+1,active:false,value:null});
          }
          await changed(tx);
          return 'applied' as const;
        });
      },
    },
  };
}

/** One upstream Session per trusted, serialized turn. Canonical transcript is
 * append-only; model compaction lives separately and cannot erase source facts.
 * Use the runtime's host.input for durable jobs; this adapter also supports
 * applications using upstream Runner directly. */
export function createConversationSession(service: ReturnType<typeof createConversation>, scope: ConversationScope, turnRef: string): Session {
  scope = normalizedScope(scope);
  let batch = 0;
  let head: number | undefined;
  return {
    getSessionId: async () => digest(scope),
    getItems: async limit => { const view = await service.context(scope); if (limit !== undefined && limit < view.items.length) throw Error('SESSION_LIMIT_WOULD_DROP_CONTEXT'); head=view.revision; return view.items; },
    replaceHistoryWithCompaction: async items => { if (head === undefined) throw Error('CONVERSATION_SNAPSHOT_REQUIRED'); await service.compact(scope,head,items); },
    addItems: async items => { await service.append(scope, { id: `${turnRef}:${batch++}`, items, sourceRefs: [turnRef] }); },
    popItem: async () => { throw Error('CANONICAL_HISTORY_IMMUTABLE'); },
    clearSession: async () => { throw Error('CANONICAL_HISTORY_IMMUTABLE'); },
  };
}

/** Enqueue/reconcile native work through the EXISTING effect ledger. The host
 * adapter must return the original native receipt and conclusively distinguish
 * unknown from not-applied. It does not await execution of the delegated job. */
export function createDelegatedWorkAdapter(deps: {
  conversation: ReturnType<typeof createConversation>;
  resolve(request: EffectRequest): Promise<{scope: ConversationScope; originEntryId: string}>;
  executor: {
    dispatch(binding: WorkBinding, signal: AbortSignal): ReturnType<EffectAdapter['dispatch']>;
    reconcile(binding: WorkBinding, signal: AbortSignal): ReturnType<EffectAdapter['reconcile']>;
  };
}): EffectAdapter {
  const invoke = async (op: 'dispatch' | 'reconcile', request: EffectRequest, signal: AbortSignal) => {
    const {scope,originEntryId} = await deps.resolve(request);
    let work = await deps.conversation.work.read(scope, request.effectRef);
    if (!work) {
      await deps.conversation.work.bind(scope,{effect:request,originEntryId,instructionRevision:request.identity.instructionRevision});
      work = await deps.conversation.work.read(scope,request.effectRef);
    }
    if (!work || work.binding.originEntryId !== originEntryId || !equal(work.binding.effect, request)) throw Error('WORK_BINDING_CONFLICT');
    return deps.executor[op](work.binding, signal);
  };
  return { dispatch: (r,s) => invoke('dispatch',r,s), reconcile: (r,s) => invoke('reconcile',r,s) };
}

/** Shared trusted-server composition. Turns use the existing durable Runner,
 * leases, approvals, effects and shutdown behavior. The host binds each admitted
 * job to a canonical conversation head; corrections invalidate stale input. */
export function createConversationAgentRuntime(deps: Omit<Parameters<typeof createAgentRuntime>[0], 'host'> & {
  host: Omit<Parameters<typeof createAgentRuntime>[0]['host'], 'input'>;
  conversation: ReturnType<typeof createConversation>;
  turn(identity: JobIdentity): Promise<{ scope: ConversationScope; head: number }>;
}) {
  const turn = async (identity: JobIdentity) => {
    const binding = await deps.turn(identity);
    if (binding.scope.tenantRef !== identity.host.tenantRef || binding.scope.userRef !== identity.host.userRef) throw Error('CONVERSATION_SCOPE_CONFLICT');
    return binding;
  };
  return createAgentRuntime({ ...deps, host: { ...deps.host,
    input: async identity => {
      const binding = await turn(identity), context = await deps.conversation.context(binding.scope);
      if (context.head !== binding.head) throw Error('CONVERSATION_REVISION_CONFLICT');
      return context.items;
    },
    prepareModelInput: async (identity, input, signal) => {
      return deps.host.prepareModelInput ? deps.host.prepareModelInput(identity,input,signal) : input;
    },
    output: async (identity, text) => {
      const binding = await turn(identity), id = `reply:${digest(identity)}`;
      const prior = await deps.conversation.readEntry(binding.scope,id);
      if (prior) {
        const item = prior.items[0];
        if (!prior.receiptRef || item?.type !== 'message' || item.role !== 'assistant') throw Error('CONVERSATION_REPLY_CONFLICT');
        return {text:item.content.filter(c=>c.type === 'output_text').map(c=>c.text).join(''),receiptRef:prior.receiptRef};
      }
      const output = await deps.host.output(identity,text);
      await deps.conversation.append(binding.scope,{id,receiptRef:output.receiptRef,sourceRefs:[identity.jobId,output.receiptRef],
        items:[{role:'assistant',type:'message',status:'completed',content:[{type:'output_text',text:output.text}]}]});
      return output;
    },
  } });
}

/** Use upstream Responses compaction against a bounded staging session, then
 * CAS the resulting view. 0.18's wrapper clears/rebuilds its underlying store;
 * staging prevents that sequence from clearing canonical durable history. */
export async function compactConversation(deps: {
  conversation: ReturnType<typeof createConversation>; scope: ConversationScope;
  client: NonNullable<ConstructorParameters<typeof OpenAIResponsesCompactionSession>[0]['client']>;
  model: NonNullable<ConstructorParameters<typeof OpenAIResponsesCompactionSession>[0]['model']>;
}) {
  const snapshot = await deps.conversation.context(deps.scope);
  const staging = new MemorySession(); await staging.addItems(snapshot.items);
  const upstream = new OpenAIResponsesCompactionSession({underlyingSession:staging,client:deps.client,model:deps.model,compactionMode:'input'});
  const usage = await upstream.runCompaction({force:true,store:false});
  await deps.conversation.compact(deps.scope,snapshot.revision,await staging.getItems());
  return usage;
}
