import { randomUUID } from 'node:crypto';
import type { ConversationAuthority, ConversationScope, ConversationStorage, ConversationTransaction } from './conversation.js';
import { canonicalAgentJson } from './agent-state-binding.js';
import type { HostedSessionBinding } from './hosted-session.js';

/** Provider identity lives beside the canonical transcript, in the existing
 * encrypted conversation store. This is not another transcript or job ledger.
 * Admission's conversation writer must stay held while the caller uses it. */
export function createHostedConversationStore(deps: {
  storage: ConversationStorage;
  authority: ConversationAuthority;
}) {
  return {
    async open(scope: ConversationScope, create: (scope: ConversationScope, key: string) => HostedSessionBinding) {
      if (!scope.conversationRef) throw new Error('HOSTED_CONVERSATION_REQUIRED');
      scope = { tenantRef: scope.tenantRef, userRef: scope.userRef, conversationRef: scope.conversationRef };
      const id = 'openai-hosted-session';
      const transaction = <T>(run: (tx: ConversationTransaction) => Promise<T>) =>
        deps.authority.withAccess(scope, 'context', () => deps.storage.transaction(scope, run));
      let record = await transaction(async tx => {
        const existing = await tx.get('state', id);
        if (existing) return existing;
        const initial = { id, revision: 1, order: 1, value: create(scope, randomUUID()) };
        await tx.put('state', initial);
        return initial;
      });
      const validate = (value: unknown): HostedSessionBinding => {
        const binding = value as HostedSessionBinding;
        if (!binding || typeof binding.creationKey !== 'string' || typeof binding.scopeDigest !== 'string'
          || typeof binding.configurationDigest !== 'string' || (binding.sessionId !== undefined && typeof binding.sessionId !== 'string'))
          throw new Error('HOSTED_SESSION_BINDING_INVALID');
        return structuredClone(binding);
      };
      return {
        get binding() { return validate(record.value); },
        async save(next: HostedSessionBinding): Promise<void> {
          validate(next);
          const prior = validate(record.value);
          if (prior.creationKey !== next.creationKey || prior.scopeDigest !== next.scopeDigest
            || prior.configurationDigest !== next.configurationDigest
            || prior.bootstrapJobId !== next.bootstrapJobId
            || prior.sessionId && prior.sessionId !== next.sessionId
            || prior.creationAttempted && !next.creationAttempted) throw new Error('HOSTED_SESSION_BINDING_CONFLICT');
          record = await transaction(async tx => {
            const current = await tx.get('state', id);
            if (!current || current.revision !== record.revision || canonicalAgentJson(current.value) !== canonicalAgentJson(record.value))
              throw new Error('HOSTED_SESSION_WRITE_CONFLICT');
            const updated = { ...current, revision: current.revision + 1, value: structuredClone(next) };
            await tx.put('state', updated);
            return updated;
          });
        },
      };
    },
  };
}
