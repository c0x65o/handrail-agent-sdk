import { validateJobCommand, validateJobSnapshot, validateJobEvent, validateJobResult, validateJobTransition } from 'handrail-agent-sdk';
import type { JobState, JobSnapshot, JobCommand, JobResult, JobEvent, JobIdentity, JobObservation } from 'handrail-agent-sdk';
import * as server from 'handrail-agent-sdk/server';
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
