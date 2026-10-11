import { createManagedAgentCapabilities, type ManagedAgentCapabilitiesOptions } from 'handrail-agent-sdk/server/capabilities';
import type { createAgentRuntime } from 'handrail-agent-sdk/server/agents';

/** Call once at server bootstrap. Existing authenticated runtime options,
 * database and encryption keys remain the application's infrastructure. */
export async function enableAccountAccess(
  infrastructure: Omit<ManagedAgentCapabilitiesOptions, 'features'>,
  runtimeOptions: Parameters<typeof createAgentRuntime>[0],
) {
  const capabilities = createManagedAgentCapabilities({
    ...infrastructure,
    features: { vault: true, browser: true },
  });
  await capabilities.initialize(); // Or use the existing SDK migration command.
  const runtime = capabilities.createRuntime(runtimeOptions);
  return {
    runtime,
    // Mount GET and POST at the configured baseUrl + /:interactionRef.
    handleAccountRequest: capabilities.handleRequest,
    // Merge this list into an existing restrictive host tool allowlist, if any.
    enabledToolNames: capabilities.toolNames,
    status: capabilities.status,
    close: capabilities.close,
  };
}
