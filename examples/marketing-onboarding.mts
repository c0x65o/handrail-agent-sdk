// Native host composition only; no provider calls, login or services on import.
import type { Setup, Grant, Permission } from '@handrail/marketing/core';
import type { AgentPort } from '@handrail/marketing/server';
import { createVaultEntry, createVaultUse } from 'handrail-agent-sdk/server';
import type { ConnectionStore, VaultEntryHost, VaultEntryStore, VaultUseHost, VaultUsePort } from 'handrail-agent-sdk/server';
import type { AgentCall, AgentRuntimeTool } from 'handrail-agent-sdk/server/agents';
import type { VaultOperation } from 'handrail-agent-sdk';
import { createMarketingOnboarding, createMetaOAuthCallback, createMetaVaultExecutor } from 'handrail-agent-sdk/server/marketing';
import type { MarketingOnboardingHost, MetaOAuthCallbackHost, MetaExecutorBinding, MetaExecutorHost,
  MetaPrivateClient, MetaPrivateCustody, MetaPrivateValue } from 'handrail-agent-sdk/server/marketing';
import type { MarketingOnboardingResult } from 'handrail-agent-sdk/marketing';

// Marketing has no named inspect-result export and no capability field on it.
type MarketingResult = Awaited<ReturnType<AgentPort['inspect']>>;
const readCapabilities: Record<Extract<MarketingOnboardingResult, { state: 'ready' }>['capabilities'][number],
  Extract<Permission, 'setup' | 'report'>> = {
  'meta.account.read': 'setup',
  'meta.report.read': 'report',
};

export function marketingAgentPort(host: MarketingOnboardingHost<Setup, Grant>, connections: ConnectionStore,
  entry: Pick<ReturnType<typeof createVaultEntry<MetaPrivateValue>>, 'issue'>) {
  const onboarding = createMarketingOnboarding(host, connections, entry);
  const agentPort: AgentPort = {
    async inspect(setup, grant): Promise<MarketingResult> {
      const result = await onboarding.inspect(setup, grant);
      switch (result.state) {
        case 'blocked': return { state: 'blocked', reason: result.reason, handoffUrl: null };
        case 'waiting_human': return { state: 'waiting_human', reason: 'provider_consent_required', handoffUrl: result.handoffUrl };
        case 'ready': {
          // These mean account verification and reporting only. Never copy them
          // into Setup or Grant: Marketing independently verifies capabilities.
          const capabilities = result.capabilities.map(capability => readCapabilities[capability]);
          return capabilities.includes('setup') && capabilities.includes('report')
            ? { state: 'ready', reason: null, handoffUrl: null }
            : { state: 'blocked', reason: 'unavailable', handoffUrl: null };
        }
        default: { const exhaustive: never = result; return exhaustive; }
      }
    },
  };
  // requestAccess belongs on an authenticated human route, never an agent tool.
  return { agentPort, onboarding };
}

export interface NativeMarketingPorts {
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

export function marketingExtension(native: NativeMarketingPorts) {
  const entry = createVaultEntry(native.entryHost, native.entryStore);
  const { onboarding, agentPort } = marketingAgentPort(native.onboarding, native.connections, entry);
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

// Inject agentPort into MarketingServer. When omitted, Marketing's manual
// connection workflow remains available. Keep this example in server code only.
