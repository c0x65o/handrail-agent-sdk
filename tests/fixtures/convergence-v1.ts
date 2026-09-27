import type {
  JobIdentity, JobRequirement, JobAnswer, JobSnapshot, JobEvent, JobDelivery,
  ConnectionEnsureInput, ConnectionEnsureResult,
} from 'handrail-agent-sdk';

// Approved synthetic aliases only. No credential material, secret-derived data,
// provider handles or claims of execution. This file is compiled by tsc, not stripped.
const identity = {
  jobId: 'fixture.job', originTaskRef: 'fixture.original-task', requestKey: 'fixture.request', instructionRevision: 1,
  host: { tenantRef: 'fixture.tenant', userRef: 'fixture.user', projectRef: 'fixture.project',
    accountRef: 'fixture.account', environmentRef: 'fixture.environment', purposeRef: 'fixture.purpose' },
  native: { requestRef: 'fixture.native-request', rootTaskRef: 'fixture.root-task',
    actionRef: 'fixture.action', operationRef: 'fixture.operation', effectRef: 'fixture.effect',
    sourceQueue: { queueRef: 'fixture.queue', messageRef: 'fixture.original-message' } },
  origin: { channelRef: 'fixture.channel', routeRef: 'fixture.route', correlationRef: 'fixture.correlation' },
} satisfies JobIdentity;
const request = {
  operation: 'connection.ensure', identity, connectionRef: 'fixture.connection', providerRef: 'fixture.provider',
  prerequisiteVersion: 'fixture.prerequisites-v1', minimumCapabilities: ['fixture.api.read'], evidenceMode: 'fixture',
  effect: { actionRef: 'fixture.action', operationRef: 'fixture.operation', effectRef: 'fixture.effect' },
} satisfies ConnectionEnsureInput;
const requirement = {
  kind: 'secure_input', requirementRef: 'fixture.challenge', revision: 1,
  actor: { kind: 'user', actorRef: identity.host.userRef },
} satisfies JobRequirement;
const answer = {
  requirementRef: requirement.requirementRef, requirementRevision: requirement.revision, responseRef: 'fixture.private-response',
} satisfies JobAnswer;
const unverified = { state: 'unverified' } as const;
const requested = { request, state: 'requested', authorization: unverified } satisfies ConnectionEnsureResult;
const inspecting = { request, state: 'inspecting', authorization: unverified } satisfies ConnectionEnsureResult;
const missing = { request, state: 'waiting_for_user', authorization: unverified,
  missingRequirements: [{ ...requirement, reason: 'credentials_required' }],
} satisfies ConnectionEnsureResult;
const verifying = { request, state: 'verifying', authorization: unverified } satisfies ConnectionEnsureResult;
const ready = {
  request, state: 'ready', authorization: { state: 'active', expiresAt: 1_800_000_060_000 },
  evidence: { kind: 'api_capabilities', receiptRef: 'fixture.capability-receipt',
    provenance: { kind: 'fixture', fixtureRef: 'fixture.convergence-v1' }, scope: identity.host,
    providerRef: request.providerRef, prerequisiteVersion: request.prerequisiteVersion,
    verifiedCapabilities: ['fixture.api.read'], verifiedAt: 1_800_000_006_000, expiresAt: 1_800_000_060_000 },
} satisfies ConnectionEnsureResult;
const unknown = {
  request, state: 'unknown_effect', authorization: ready.authorization,
  effect: { ...request.effect, outcome: 'unknown' }, reconciliationRef: 'fixture.reconciliation',
} satisfies ConnectionEnsureResult;
const queued = { identity, revision: 1, state: 'queued', effects: [] } satisfies JobSnapshot;
const running = { ...queued, revision: 2, state: 'running' } satisfies JobSnapshot;
const waiting = { ...running, revision: 3, state: 'waiting', requirement } satisfies JobSnapshot;
const answered = { ...waiting, revision: 4, answer } satisfies JobSnapshot;
const resumed = { ...queued, revision: 5 } satisfies JobSnapshot;
const restarted = { ...running, revision: 6 } satisfies JobSnapshot;
const uncertain = { ...restarted, revision: 7, effects: [unknown.effect] } satisfies JobSnapshot;

type Step = {
  readonly stepRef: string;
  readonly now: number;
  readonly delivery: JobDelivery;
  readonly connection: ConnectionEnsureResult;
} & (
  | { readonly kind: 'append'; readonly event: JobEvent }
  | { readonly kind: 'duplicate' | 'restart'; readonly snapshot: JobSnapshot }
);
interface SyntheticWorkflow {
  readonly fixtureRef: string;
  readonly evidenceMode: 'fixture';
  readonly identity: JobIdentity;
  readonly request: ConnectionEnsureInput;
  readonly requirement: JobRequirement;
  readonly steps: readonly Step[];
}
export const workflow = {
  fixtureRef: 'fixture.convergence-v1', evidenceMode: 'fixture', identity, request, requirement,
  steps: [
    { stepRef: 'fixture.submit', now: 1_800_000_000_000, kind: 'append', delivery: { attemptRef: 'fixture.attempt-1' },
      connection: requested, event: { kind: 'submitted', previousRevision: 0, snapshot: queued } },
    { stepRef: 'fixture.start', now: 1_800_000_001_000, kind: 'append', delivery: { attemptRef: 'fixture.attempt-2' },
      connection: inspecting, event: { kind: 'started', previousRevision: 1, snapshot: running } },
    { stepRef: 'fixture.missing', now: 1_800_000_002_000, kind: 'append', delivery: { attemptRef: 'fixture.attempt-3' },
      connection: missing, event: { kind: 'waiting', previousRevision: 2, snapshot: waiting } },
    { stepRef: 'fixture.duplicate', now: 1_800_000_003_000, kind: 'duplicate', delivery: { attemptRef: 'fixture.attempt-4' },
      connection: missing, snapshot: waiting },
    { stepRef: 'fixture.restart', now: 1_800_000_004_000, kind: 'restart', delivery: { attemptRef: 'fixture.attempt-5' },
      connection: missing, snapshot: waiting },
    { stepRef: 'fixture.answer', now: 1_800_000_005_000, kind: 'append', delivery: { attemptRef: 'fixture.attempt-6' },
      connection: verifying, event: { kind: 'answered', previousRevision: 3, snapshot: answered,
        command: { command: 'answer', identity, expectedRevision: 3, answer } } },
    { stepRef: 'fixture.resume', now: 1_800_000_006_000, kind: 'append', delivery: { attemptRef: 'fixture.attempt-7' },
      connection: ready, event: { kind: 'resumed', previousRevision: 4, snapshot: resumed,
        command: { command: 'resume', identity, expectedRevision: 4, requirementRef: requirement.requirementRef,
          requirementRevision: requirement.revision, resolutionReceiptRef: 'fixture.resolution-receipt' } } },
    { stepRef: 'fixture.continue', now: 1_800_000_007_000, kind: 'append', delivery: { attemptRef: 'fixture.attempt-8' },
      connection: ready, event: { kind: 'started', previousRevision: 5, snapshot: restarted } },
    { stepRef: 'fixture.unknown', now: 1_800_000_008_000, kind: 'append', delivery: { attemptRef: 'fixture.attempt-9' },
      connection: unknown, event: { kind: 'effects_recorded', previousRevision: 6, snapshot: uncertain } },
    { stepRef: 'fixture.restart-unknown', now: 1_800_000_009_000, kind: 'restart', delivery: { attemptRef: 'fixture.attempt-10' },
      connection: unknown, snapshot: uncertain },
  ],
} satisfies SyntheticWorkflow;
