/** Public classifications only. Never copy provider messages, tool input or URLs
 * into the job journal. Unknown provider codes remain private diagnostic data. */
export const PROVIDER_FAILURE_MESSAGES = {
  context_length_exceeded: 'The conversation exceeded the model’s context capacity. Start a new conversation with the relevant details.',
  session_budget_exceeded: 'OpenAI stopped the session at its configured usage limit. Ask the administrator to review the provider session configuration.',
  usage_limit_exceeded: 'OpenAI’s usage or billing limit was reached. Ask the administrator to check provider usage and billing.',
  project_spend_limit_exceeded: 'The OpenAI project’s spend limit was reached. Ask the administrator to review provider billing.',
  organization_spend_limit_exceeded: 'The OpenAI organization’s spend limit was reached. Ask the administrator to review provider billing.',
  organization_usage_limit_exceeded: 'The OpenAI organization’s usage limit was reached. Ask the administrator to review provider usage.',
  credit_balance_exhausted: 'The OpenAI account has no API credits remaining. Ask the administrator to review provider billing.',
  rate_limit_exceeded: 'OpenAI’s request rate limit was reached. Wait before continuing the unfinished work.',
  flex_unavailable: 'OpenAI Flex processing is temporarily unavailable. Wait before continuing the unfinished work.',
  server_overloaded: 'OpenAI’s model service is overloaded. Wait before continuing the unfinished work.',
  cyber_policy: 'OpenAI’s safety policy blocked this request. Review the request before continuing.',
  misalignment_policy_violation: 'OpenAI’s safety systems blocked this request. Review the request before continuing.',
  connection_failed: 'The hosted agent could not connect to OpenAI’s model service. Check service availability before continuing.',
  server_error: 'OpenAI’s model service encountered an error. Check service availability before continuing the unfinished work.',
  authentication_error: 'OpenAI rejected the configured credentials or access. Ask the administrator to check the provider connection.',
  invalid_request: 'OpenAI rejected the request or its configuration. Ask the administrator to inspect the saved failure details.',
  resource_not_found: 'The requested OpenAI model or resource is unavailable. Ask the administrator to check the provider configuration.',
  sandbox_error: 'The hosted execution environment failed. Ask the administrator to inspect the saved environment failure before continuing.',
  executor_version_incompatible: 'The hosted executor version is incompatible. Ask the administrator to update the executor.',
  active_turn_not_steerable: 'The hosted agent could not accept additional input while running. Check the original request’s status before continuing.',
  request_timeout: 'OpenAI’s model request timed out. Check any completed actions before continuing the unfinished work.',
  internal_error: 'OpenAI reported an internal failure. Check any completed actions before continuing the unfinished work.',
  unknown: 'The hosted agent failed without a recognized error category. Ask the administrator to inspect the saved provider failure.',
} as const;
export type ProviderFailureCode = keyof typeof PROVIDER_FAILURE_MESSAGES;
export function providerFailureCode(code: unknown): ProviderFailureCode {
  return typeof code === 'string' && Object.hasOwn(PROVIDER_FAILURE_MESSAGES, code) ? code as ProviderFailureCode : 'unknown';
}
