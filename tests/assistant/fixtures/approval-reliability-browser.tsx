import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createInitialConversationState, parseConversationEvent, reduceConversationEvent,
  type ConversationApprovalProposalRecord } from "../../../src/assistant/index.js";
import { StyledChatPreset, StyledChatPresetStyles } from "../../../src/assistant/react-styled/index.js";

const stamp = "2026-10-20T00:46:42.623Z";
function App() {
  const [phase, setPhase] = useState("pending");
  let state = createInitialConversationState("fixture" as never);
  const payloads: object[] = [
    { type: "message.created", message_id: "message", role: "user", content: [{ type: "text", text: "Set up the exact reviewed action. Do not operate the device." }] },
    { type: "turn.started", turn_id: "turn", input_message_ids: ["message"] },
    { type: "tool_call.requested", turn_id: "turn", tool_call_id: "bind", name: "bind_device", arguments: { device: "Fixture only" } },
    { type: "tool_call.approval_required", turn_id: "turn", tool_call_id: "bind" },
    { type: "turn.status_changed", turn_id: "turn", status: "waiting_for_approval" },
  ];
  if (phase === "failed") payloads.push({ type: "turn.failed", turn_id: "turn",
    error: { code: "internal_error", message: "The saved continuation failed. Approval remains saved.", retryable: true } });
  for (const payload of payloads) state = reduceConversationEvent(state, parseConversationEvent({ version: 1,
    conversation_id: "fixture", event_id: `event-${(state.revision ?? 0) + 1}`, revision: (state.revision ?? 0) + 1,
    occurred_at: stamp, actor: { type: "system" }, source: { type: "runtime" }, payload }));
  const proposal = { proposal_id: "proposal", group_id: "fixture", turn_id: "turn", tool_call_id: "bind",
    tool_name: "bind_device", proposal_version: phase === "pending" ? 1 : 2,
    status: phase === "pending" ? "pending" : "confirmed", expires_at: null, created_at: stamp, updated_at: stamp,
    reviewed_arguments: { type: "redacted_json", value: { device: "Fixture only" } } } as ConversationApprovalProposalRecord;
  return <><StyledChatPresetStyles/><nav aria-label="Test controls">{["pending", "confirmed", "failed"].map(value =>
    <button key={value} onClick={() => setPhase(value)}>{value}</button>)}</nav>
    <StyledChatPreset state={state} proposals={[proposal]} title="Family Assistant · isolated test"
      transcription={false} toolActivity="expanded" style={{ height: "calc(100vh - 50px)" }}
      theme={{ colors: { accent: "#a96743", background: "#fffdf7", panel: "#f8f2e8", text: "#554f45", muted: "#968873", border: "#e8dac3" } }}/></>;
}
createRoot(document.getElementById("root")!).render(<App/>);
