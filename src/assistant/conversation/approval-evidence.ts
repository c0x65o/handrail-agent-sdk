import type { ConversationEventStore } from "./event-store.js";
import type { ConversationApprovalProposalId, ConversationEvent, ConversationId, ConversationRevision } from "./events.js";

/** Older adapters can page to the head observed on the first read. */
export async function readApprovalEvidence(store: ConversationEventStore, conversationId: ConversationId,
  proposalId: ConversationApprovalProposalId, pageSize: number, signal?: AbortSignal): Promise<ConversationEvent[]> {
  const matches = (event: ConversationEvent) => event.conversation_id === conversationId &&
    (event.payload.type === "approval.proposal_created" || event.payload.type === "approval.proposal_status_changed") &&
    event.payload.proposal_id === proposalId;
  if (store.readApprovalEvents) {
    const events = await store.readApprovalEvents(conversationId, proposalId);
    if (!events.every(matches)) throw new TypeError("Unexpected approval audit event.");
    return originalApprovalEvidence(events);
  }
  const events: ConversationEvent[] = [];
  let revision: ConversationRevision | undefined;
  let head: ConversationRevision | null | undefined;
  do {
    signal?.throwIfAborted();
    const page = await store.read({ conversationId, ...(revision === undefined ? {} : { after: { revision } }), limit: pageSize });
    if (head === undefined) head = page.latestRevision;
    if (head === null) break;
    for (const { event } of page.entries) {
      if (event.revision !== (revision ?? 0) + 1 || event.conversation_id !== conversationId) {
        throw new TypeError("Incomplete approval audit history.");
      }
      revision = event.revision;
      if (matches(event)) events.push(event);
      if (revision === head) break;
    }
    if (revision !== head && (!page.hasMore || !page.entries.length)) throw new TypeError("Incomplete approval audit history.");
  } while (revision !== head);
  return originalApprovalEvidence(events);
}

/** Keep original approval evidence while validating later display-only copies. */
export function originalApprovalEvidence(events: readonly ConversationEvent[]): ConversationEvent[] {
  const originals = new Map<string, ConversationEvent>();
  for (const event of events) {
    const reference = event.metadata?.repair_of_event_id;
    if (reference === undefined) {
      originals.set(event.event_id, event);
      continue;
    }
    const original = typeof reference === "string" ? originals.get(reference) : undefined;
    if (!original || event.mutation_id !== undefined ||
      event.conversation_id !== original.conversation_id || event.revision <= original.revision ||
      event.occurred_at !== original.occurred_at ||
      JSON.stringify(event.actor) !== JSON.stringify(original.actor) ||
      JSON.stringify(event.source) !== JSON.stringify(original.source) ||
      JSON.stringify(event.payload) !== JSON.stringify(original.payload)) {
      throw new TypeError("Approval projection does not match retained original evidence.");
    }
  }
  return [...originals.values()];
}
