import { createContext, useContext, type ComponentType, type HTMLAttributes, type ButtonHTMLAttributes } from "react";
import type { McpToolGrant } from "../mcp/registry.js";
import type { ConversationToolCallRecord } from "../conversation/state.js";
import { StructuredDetailsDisclosure, structuredDetailLabel } from "./structured-details.js";

/** Wrap the assistant in this provider to use host design-system components.
 * Both components must forward native attributes, children and events. */
export const AssistantReviewComponents = createContext<{
  Card?: ComponentType<HTMLAttributes<HTMLElement>>;
  Button?: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>>;
}>({});
export function useAssistantReviewComponents() {
  const { Card = "article", Button = "button" } = useContext(AssistantReviewComponents);
  return { Card, Button };
}

export interface RegistryConsentPromptProps {
  readonly additions: readonly McpToolGrant[];
  readonly onAccept: (reviewed: readonly McpToolGrant[]) => void;
  readonly busy?: boolean;
  readonly error?: string;
}
export function RegistryConsentPrompt({ additions, onAccept, busy, error }: RegistryConsentPromptProps) {
  const { Card, Button } = useAssistantReviewComponents();
  if (!additions.length) return null;
  return <Card className="hr-chat__approval" role="listitem" aria-label="Assistant access request">
    <strong>Review assistant access</strong>
    <span>Allow the assistant to use these additional tools or permissions?</span>
    <ul className="hr-chat__access-list">{additions.map(tool => <li key={tool.name}>{tool.name}{tool.scopes.length > 0 && <> ({tool.scopes.join(", ")})</>}</li>)}</ul>
    {error && <p role="alert">{error}</p>}
    <div className="hr-chat__approval-actions"><Button type="button" disabled={busy}
      onClick={() => onAccept(additions)}>Allow listed access</Button></div>
  </Card>;
}
export function MutationReceipt({ call }: { readonly call: ConversationToolCallRecord }) {
  const { Card } = useAssistantReviewComponents();
  if (!call.result || call.result.is_error) return null;
  return <Card className="hr-chat__approval" role="listitem" aria-label="Mutation receipt">
    <strong>{structuredDetailLabel(call.name ?? "Action")}</strong>
    <span className="hr-chat__approval-status">Completed</span>
    <StructuredDetailsDisclosure always defaultOpen={false} summary="Receipt details"
      value={{ reference: call.tool_call_id, recorded_at: call.result.recorded_at }}/>
  </Card>;
}
