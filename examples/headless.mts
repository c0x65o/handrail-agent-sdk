// Trusted server integration. No browser/client import, implicit credential
// lookup, new application database, queue or service starts here.
import { z } from 'zod';
import { createAgentRuntime } from 'handrail-agent-sdk/server/agents';
import type { AgentCall, AgentRuntimeTool } from 'handrail-agent-sdk/server/agents';
import type { VaultOperation } from 'handrail-agent-sdk';
import type { createVaultUse } from 'handrail-agent-sdk/server';

type Dependencies = Parameters<typeof createAgentRuntime>[0];
export function createHeadlessWorker(ports: Omit<Dependencies, 'definitionRef' | 'instructions' | 'tools' | 'limits'>) {
  return createAgentRuntime({ ...ports,
    definitionRef: 'quote-assistant-v1',
    instructions: 'Calculate a quote from the supplied quantity and price. Explain the result. Tool errors are failures, not success.',
    tools: [{ name: 'quote', description: 'Multiply quantity by unit price.', kind: 'read',
      parameters: z.object({ quantity: z.number().int().min(1).max(100), price: z.number().min(0).max(10000) }).strict(),
      execute: async call => String(Number(call.input.quantity) * Number(call.input.price)),
    }],
    limits: { maxTurns: 8, maxDispatches: 5, maxToolCalls: 16, maxContextBytes: 24000,
      maxStateBytes: 65536, maxOutputBytes: 4096, maxElapsedMs: 60000, leaseTtlMs: 15000, pollMs: 2000 },
  });
}

// Optional private filling composition. The model sees only a permitted-use
// reference. Existing Vault custody, destination/lease checks and reconciliation
// remain in createVaultUse; no password, SSN, card or token enters RunState.
export function privateFillTool(
  vault: Pick<ReturnType<typeof createVaultUse>, 'execute'>,
  resolveApprovedGrant: (call: AgentCall) => Promise<VaultOperation>,
): AgentRuntimeTool {
  return { name: 'fill_approved_field', description: 'Use a previously approved private-field grant.', kind: 'vault',
    parameters: z.object({ grantRef: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).strict(),
    bind: resolveApprovedGrant, vault };
}

// Host startup: await worker.start(). Queue/schedule delivery:
// await worker.wake(originalServerDerivedIdentity).
// Verified answer: await worker.resume(identity); await worker.wake(identity).
// Explicit Stop: use createJobCancellation.stop(), never worker.stop().
// Process shutdown: await worker.stop(), then close host-owned pools.
// Supply an official OpenAIProvider().getModel(hostApprovedModel) or an existing
// Model adapter configured with the host's authorized provider connection.
