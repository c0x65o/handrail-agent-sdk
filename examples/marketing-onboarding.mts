// Native host composition only; no provider calls, login or services on import.
import { createVaultEntry, createVaultUse } from 'handrail-agent-sdk/server';
import type { ConnectionStore, VaultEntryHost, VaultEntryStore, VaultUseHost, VaultUsePort } from 'handrail-agent-sdk/server';
import type { AgentCall, AgentRuntimeTool } from 'handrail-agent-sdk/server/agents';
import type { VaultOperation } from 'handrail-agent-sdk';
import { createMarketingOnboarding, createMetaOAuthCallback, createMetaVaultExecutor } from 'handrail-agent-sdk/server/marketing';
import type { MarketingOnboardingHost, MetaOAuthCallbackHost, MetaExecutorBinding, MetaExecutorHost,
  MetaPrivateClient, MetaPrivateCustody, MetaPrivateValue } from 'handrail-agent-sdk/server/marketing';
import type { MarketingOnboardingPort } from 'handrail-agent-sdk/marketing';

export interface NativeMarketingPorts<Setup, Grant> {
  readonly onboarding: MarketingOnboardingHost<Setup, Grant>;
  readonly connections: ConnectionStore;
  readonly entryHost: VaultEntryHost;
  readonly entryStore: VaultEntryStore<MetaPrivateValue>;
  readonly callbackHost: MetaOAuthCallbackHost;
  readonly useHost: VaultUseHost;
  readonly usePort: VaultUsePort<MetaPrivateValue>;
  readonly executorHost: MetaExecutorHost;
  readonly privateClient: MetaPrivateClient;
  readonly custody: MetaPrivateCustody;
  /** Resolve the persisted native grant for this runtime call, including the
   * exact original call.effectRef/identity. Tool input cannot approve access. */
  resolveCall(call: AgentCall): Promise<VaultOperation>;
  /** Resolve/re-authorize the immutable recipe for an exact admitted operation.
   * No caller-supplied account, URL, capability, code or token is accepted. */
  resolveOperation(request: VaultOperation): Promise<MetaExecutorBinding>;
}

export function marketingExtension<Setup, Grant>(native: NativeMarketingPorts<Setup, Grant>) {
  const entry = createVaultEntry(native.entryHost, native.entryStore);
  const onboarding = createMarketingOnboarding(native.onboarding, native.connections, entry);
  const agentPort: MarketingOnboardingPort<Setup, Grant> = { inspect: onboarding.inspect };
  const tool: AgentRuntimeTool = {
    kind: 'vault', name: 'verify_marketing_connection', description: 'Verify the host-approved read-only marketing connection.',
    parameters: { jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      parse(value: unknown) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw Error('INVALID_INPUT');
        return {};
      } },
    bind: call => native.resolveCall(call),
    vault: { async execute(request, fence) {
      const binding = await native.resolveOperation(request);
      const executor = createMetaVaultExecutor(binding, native.executorHost, native.privateClient, native.custody);
      return createVaultUse(native.useHost, native.usePort, [executor]).execute(request, fence);
    } },
  };
  return { agentPort, onboarding, tool, privateOAuthCallback: createMetaOAuthCallback(native.callbackHost, entry) };
}

// Marketing's server composition may inject agentPort after mapping its own
// Setup/Grant and capability vocabulary. When omitted, its manual connection
// workflow remains available. Do not serialize native ports into a UI bundle.
