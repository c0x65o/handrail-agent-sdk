import { validateJobCommand, validateJobSnapshot, validateJobEvent, validateJobResult, validateJobTransition } from 'handrail-agent-sdk';
import type { JobState, JobSnapshot, JobCommand, JobResult, JobEvent, JobIdentity, JobObservation } from 'handrail-agent-sdk';
import * as server from 'handrail-agent-sdk/server';
import { validateConnectionEnsureInput, validateConnectionEnsureResult, validateConnectionReconnect } from 'handrail-agent-sdk';
import type { ConnectionEnsureInput, ConnectionEnsureResult, ConnectionState } from 'handrail-agent-sdk';
type AssertEmpty<T extends never> = T;
type ServerExports = AssertEmpty<keyof typeof server>;
const states: Record<JobState, boolean> = { queued: true, running: true, waiting: true, succeeded: true, failed: true, cancelled: true };
declare const identity: JobIdentity;
const command: JobCommand = { command: 'cancel', identity, expectedRevision: 2, reason: 'explicit_stop' };
const parsed = validateJobCommand(command);
if (parsed.ok) { const typed: JobCommand = parsed.value; }
const snapshot = validateJobSnapshot({});
if (snapshot.ok) {
  const typed: JobSnapshot = snapshot.value;
  if (typed.state === 'succeeded') { const verified: 'host_verified' = typed.receipt.verification; }
  // @ts-expect-error Original identity is immutable to consumers.
  typed.identity.originTaskRef = 'replacement';
  // @ts-expect-error Original route is immutable too.
  typed.identity.origin.routeRef = 'replacement';
}
const result = validateJobResult({});
if (result.ok) { const typed: JobResult = result.value; }
const event = validateJobEvent({});
if (event.ok) { const typed: JobEvent = event.value; validateJobTransition(null, typed); }
// @ts-expect-error Success requires a host-verified receipt.
const invalidSuccess: JobSnapshot = { identity, revision: 2, effects: [], state: 'succeeded' };
// @ts-expect-error UI disposal is not a cancellation command.
const invalidCommand: JobCommand = { command: 'dispose', identity };
// @ts-expect-error Resume events require the bound command.
const invalidEvent: JobEvent = { kind: 'resumed', previousRevision: 2, snapshot: { identity, revision: 3, effects: [], state: 'queued' } };
const observation: JobObservation = { dispose() {} };
observation.dispose();
// @ts-expect-error Implementation paths stay private.
import 'handrail-agent-sdk/dist/server/index.js';
// @ts-expect-error Contract is exposed through the root entrypoint only.
import 'handrail-agent-sdk/dist/contracts/job.js';
declare const connectionInput: ConnectionEnsureInput;
const connection = validateConnectionEnsureResult({}, connectionInput, 10000);
validateConnectionEnsureInput(connectionInput);
if (connection.ok) {
  const typed: ConnectionEnsureResult = connection.value;
  const state: ConnectionState = typed.state;
  validateConnectionReconnect(typed, typed, 10000);
  // @ts-expect-error Reconnect cannot replace the original task.
  typed.request.identity.originTaskRef = 'replacement';
  // @ts-expect-error Capabilities are readonly.
  typed.request.minimumCapabilities.push('extra');
  if (typed.state === 'ready') {
    const active: 'active' = typed.authorization.state;
    // @ts-expect-error Verification facts are readonly.
    typed.evidence.provenance.kind = 'fixture';
  }
}
// @ts-expect-error Ready requires API evidence.
const invalidReady: ConnectionEnsureResult = { request: connectionInput, authorization: { state: 'active', expiresAt: 20000 }, state: 'ready' };
// @ts-expect-error Unknown effects require reconciliation identity.
const invalidUnknown: ConnectionEnsureResult = { request: connectionInput, authorization: { state: 'unverified' }, state: 'unknown_effect' };
// @ts-expect-error Contract implementation paths remain private.
import 'handrail-agent-sdk/dist/contracts/connection.js';
