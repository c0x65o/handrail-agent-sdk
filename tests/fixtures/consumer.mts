import { validateJobCommand, validateJobSnapshot, validateJobEvent, validateJobResult, validateJobTransition } from 'handrail-agent-sdk';
import type { JobState, JobSnapshot, JobCommand, JobResult, JobEvent, JobIdentity, JobObservation } from 'handrail-agent-sdk';
import * as server from 'handrail-agent-sdk/server';
import { validateConnectionEnsureInput, validateConnectionEnsureResult, validateConnectionReconnect } from 'handrail-agent-sdk';
import type { ConnectionEnsureInput, ConnectionEnsureResult, ConnectionState } from 'handrail-agent-sdk';
type AssertEmpty<T extends never> = T;
type ServerExports = AssertEmpty<Exclude<keyof typeof server, 'createJobAdmission' | 'createJobLease' | 'createJobCancellation' | 'createJobAnswer' | 'createEffects' | 'createVaultUse' | 'createVaultEntry' | 'createPaymentVault' | 'createPaymentFillExecutor' | 'validateVaultCardValue' | 'createVaultRequestExecutor' | 'createBrowserUse' | 'createLoginVault' | 'createLoginFillExecutor' | 'validateVaultLoginValue'>>;
import type { BrowserUseHost, TrustedBrowserExecutor, VaultLoginValue, PrivateLoginDestination } from 'handrail-agent-sdk/server';
import type { AgentRuntimeTool } from 'handrail-agent-sdk/server/agents';
declare const browserHost: BrowserUseHost, browserEffects: EffectStore, browserExecutors: readonly TrustedBrowserExecutor[];
declare const browserRequest: BrowserOperation, browserParameters: AgentRuntimeTool['parameters'];
const browserUse = server.createBrowserUse(browserHost, browserEffects, browserExecutors);
const browserTool: AgentRuntimeTool = { name: 'browser', description: 'Authorized browser operation', kind: 'browser',
  parameters: browserParameters, bind: async () => browserRequest, browser: browserUse,
  readResult: async (_call, observation) => { const kind: 'sanitized' = observation.kind; return JSON.stringify({ kind }); } };
declare const loginHost: VaultEntryHost, loginStore: VaultEntryStore<VaultLoginValue>, loginTarget: PrivateLoginDestination;
declare const loginRegistration: Pick<TrustedVaultExecutor<VaultLoginValue>, 'operationRef' | 'bind' | 'reconcile'>;
const loginEntry = server.createLoginVault(loginHost, loginStore);
const loginFill = server.createLoginFillExecutor(loginRegistration, loginTarget);
// @ts-expect-error Secure login custody does not accept verification codes.
const invalidLogin: VaultLoginValue = { password: 'synthetic', otp: '123456' };
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

import { validateVaultItem, validateVaultEntryCompletion, validateVaultOperation, validateVaultBrokerResult } from 'handrail-agent-sdk';
import type { VaultSecretReference, VaultPaymentReference, VaultBroker, VaultOperation, VaultEntryCompletion } from 'handrail-agent-sdk';
import type { VaultPermissions, VaultAgentPermissions, VaultEntryContext, VaultUseContext } from 'handrail-agent-sdk/server';
declare const secret: VaultSecretReference;
declare const payment: VaultPaymentReference;
// @ts-expect-error Specialized payment custody cannot use generic references.
const wrongPayment: VaultPaymentReference = secret;
// @ts-expect-error Payment reference cannot be used as a generic secret.
const wrongSecret: VaultSecretReference = payment;
declare const broker: VaultBroker;
// @ts-expect-error Agent reveal is unavailable.
broker.reveal(secret);
// @ts-expect-error Agent export is unavailable.
broker.export(payment);
// @ts-expect-error No public raw-value getter.
broker.get(secret);
// @ts-expect-error Trusted host policy is server-only.
import type { VaultUseGrant } from 'handrail-agent-sdk';
const humanPermissions: VaultPermissions = { use: false, reveal: true, export: true };
// @ts-expect-error Human reveal/export permissions cannot enable Agent reveal/export.
const agentPermissions: VaultAgentPermissions = humanPermissions;
declare const vaultOperation: VaultOperation;
declare const vaultCompletion: VaultEntryCompletion;
declare const vaultContext: VaultEntryContext;
declare const useContext: VaultUseContext;
validateVaultItem(vaultCompletion.item);
validateVaultEntryCompletion(vaultCompletion, vaultContext, 1000);
validateVaultOperation(vaultOperation, useContext, 1000);
validateVaultBrokerResult({}, vaultOperation);
// @ts-expect-error There is no value in reference-only completion.
vaultCompletion.item.value;
// @ts-expect-error Public operations cannot export values.
const exportOperation: VaultOperation = { ...vaultOperation, operation: 'export' };
if (vaultOperation.operation === 'fill') {
  // @ts-expect-error Generic secret references cannot substitute for opaque card references.
  const browserReference: VaultSecretReference = payment;
  broker.fill(vaultOperation);
}

import { validateBrowserOperation, validateBrowserOperationSchema, validateBrowserTakeoverTransition, validateBrowserObservation } from 'handrail-agent-sdk';
import type { BrowserOperation, BrowserTakeover, BrowserObservation, BrowserAction, BrowserLease } from 'handrail-agent-sdk';
import type { BrowserOperationContext, BrowserTakeoverContext, BrowserHandbackAuthorization } from 'handrail-agent-sdk/server';
declare const browserOperation: BrowserOperation;
declare const browserContext: BrowserOperationContext;
declare const takeoverContext: BrowserTakeoverContext;
declare const browserTakeover: BrowserTakeover;
const browserParsed = validateBrowserOperation(browserOperation, browserContext, 2000);
validateBrowserOperationSchema(browserOperation);
validateBrowserTakeoverTransition(browserTakeover, takeoverContext, 2000);
if (browserParsed.ok) {
  const typed: BrowserOperation = browserParsed.value;
  // @ts-expect-error Profile scope is immutable.
  typed.lease.profile.scope.accountRef = 'other';
  // @ts-expect-error Frame ancestry cannot be mutated.
  typed.document.frames.push({ frameRef: 'other', origin: 'https://fixture.example' });
}
const browserObservation = validateBrowserObservation({}, browserOperation);
if (browserObservation.ok) { const typed: BrowserObservation = browserObservation.value; }
// @ts-expect-error Model-facing contract has no arbitrary evaluation.
const evaluation: BrowserAction = { kind: 'eval', script: 'synthetic' };
// @ts-expect-error Ordinary typing resolves a host-approved nonsecret text reference.
const rawTyping: BrowserAction = { kind: 'type', elementRef: 'element', text: 'synthetic' };
// @ts-expect-error Unknown outcome requires reconciliation binding.
const unknownObservation: BrowserObservation = { request: browserOperation, kind: 'redacted', status: 'observation_withheld', effect: { ...browserOperation.effect, outcome: 'unknown' } };
// @ts-expect-error Sanitized observations require adapter attestation.
const unattested: BrowserObservation = { request: browserOperation, kind: 'sanitized', effect: { ...browserOperation.effect, outcome: 'verified' }, facts: [] };
// @ts-expect-error Trusted context stays on server type boundary.
import type { BrowserOperationContext as PublicBrowserContext } from 'handrail-agent-sdk';
// @ts-expect-error Implementation remains private.
import 'handrail-agent-sdk/dist/contracts/browser.js';

import type { JobStore, JobStoreResult } from 'handrail-agent-sdk/server';
declare const store: JobStore;
const loaded: Promise<JobStoreResult<JobSnapshot>> = store.load(identity);
if (event.ok) {
  const appended: Promise<JobStoreResult<{ readonly event: JobEvent; readonly replayed: boolean }>> = store.append(event.value);
}
// @ts-expect-error The server port has no public driver/connection handle.
store.database;

import type { JobAdmissionHost, JobAdmissionStore, JobAdmissionReceipt, JobInspection, JobSubmission } from 'handrail-agent-sdk/server';
declare const admissionHost: JobAdmissionHost;
declare const admissionStore: JobAdmissionStore;
const admission = server.createJobAdmission(admissionHost, admissionStore);
const submission: JobSubmission = { requestKey: 'key', originTaskRef: 'task', instructionRevision: 1,
  operation: { operationRef: 'operation', inputRefs: { resource: 'resource' } } };
const admitted = await admission.submit(submission);
if (admitted.ok) {
  const receipt: JobAdmissionReceipt = admitted.value;
  const inspected = await admission.inspect({ jobId: receipt.jobId });
  if (inspected.ok) {
    const state: JobInspection = inspected.value;
    // @ts-expect-error Raw journal and authorization are not observations.
    state.identity;
    // @ts-expect-error Effects are withheld from admission inspection.
    state.effects;
  }
}
// @ts-expect-error Caller identity cannot grant authority.
admission.submit({ ...submission, host: identity.host });
// @ts-expect-error Closing observation is not a cancellation API.
admission.cancel('job');

// Runtime fences and ownership remain on the server entrypoint.
import { createJobLease } from 'handrail-agent-sdk/server';
import type { JobLease, JobLeaseHost, JobLeaseStore, JobLeaseFence } from 'handrail-agent-sdk/server';
declare const leaseHost: JobLeaseHost;
declare const leaseStore: JobLeaseStore;
declare const leaseFence: JobLeaseFence;
const leases: JobLease = createJobLease(leaseHost, leaseStore);
void leases.check(leaseFence);
// @ts-expect-error runtime ownership is not a public client/model contract
import type { JobLeaseFence as PublicLeaseFence } from 'handrail-agent-sdk';

import { createEffects } from 'handrail-agent-sdk/server';
import type { EffectHost, EffectStore, EffectAdapter, EffectRequest, EffectObservation } from 'handrail-agent-sdk/server';
declare const effectHost: EffectHost;
declare const effectStore: EffectStore;
declare const effectAdapter: EffectAdapter;
declare const effectRequest: EffectRequest;
const effects = createEffects(effectHost, effectStore, effectAdapter);
const effectResult: Promise<JobStoreResult<EffectObservation>> = effects.execute(effectRequest, leaseFence);
void effects.reconcile(effectRequest);
// @ts-expect-error The effect adapter stays on the trusted server boundary.
import type { EffectAdapter as PublicEffectAdapter } from 'handrail-agent-sdk';
// @ts-expect-error Verified results require the original safe receipt.
const incompleteEffect: EffectObservation = { outcome: 'verified' };

import { createVaultUse } from 'handrail-agent-sdk/server';
import type { VaultUseHost, VaultUsePort, TrustedVaultExecutor, VaultItemGrantPort } from 'handrail-agent-sdk/server';
declare const vaultUseHost: VaultUseHost;
declare const vaultUsePort: VaultUsePort<{ token: string }>;
declare const privateExecutor: TrustedVaultExecutor<{ token: string }>;
declare const vaultRequest: import('handrail-agent-sdk').VaultOperation;
declare const grantAdmin: VaultItemGrantPort;
const vaultUse = createVaultUse(vaultUseHost, vaultUsePort, [privateExecutor]);
const vaultEffect: Promise<JobStoreResult<EffectObservation>> = vaultUse.execute(vaultRequest, leaseFence);
void grantAdmin.history(vaultRequest.item, 50);
// @ts-expect-error Private executor registration is server-only.
import type { TrustedVaultExecutor as PublicVaultExecutor } from 'handrail-agent-sdk';
// @ts-expect-error No value getter on the dispatch facade.
vaultUse.readForExecutor(vaultRequest.item);
// @ts-expect-error No reveal/export on the dispatch facade.
vaultUse.reveal(vaultRequest.item);
// @ts-expect-error Callers cannot pass arbitrary private-value callbacks.
vaultUse.execute(vaultRequest, leaseFence, (value: unknown) => value);

import { createVaultEntry } from 'handrail-agent-sdk/server';
import type { VaultEntryHost, VaultEntryStore, VaultEntryHandle } from 'handrail-agent-sdk/server';
declare const entryHost: VaultEntryHost;
declare const entryStore: VaultEntryStore<{ token: string }>;
declare const entryHandle: VaultEntryHandle;
const entry = createVaultEntry(entryHost, entryStore);
void entry.deliver(entryHandle);
// @ts-expect-error Private entry authority is not exposed to model/client contracts.
import type { VaultEntryHost as PublicEntryHost } from 'handrail-agent-sdk';
// @ts-expect-error Closing a surface must not cancel or resume the job.
entry.close(entryHandle);
// @ts-expect-error No private value getter on the session API.
entry.read(entryHandle);

import { createPaymentVault } from 'handrail-agent-sdk/server';
import type { VaultCardValue } from 'handrail-agent-sdk/server';
declare const paymentHost: VaultEntryHost;
declare const paymentStore: VaultEntryStore<VaultCardValue>;
const payments = createPaymentVault(paymentHost, paymentStore);
void payments.capture(entryHandle);
// @ts-expect-error No card fields on public session handles.
payments.capture({ ...entryHandle, pan: 'synthetic' });
// @ts-expect-error Security codes cannot enter custody.
payments.capture(entryHandle, { cvv: 'synthetic' });
// @ts-expect-error Payment factory exposes no purchase operation.
payments.purchase(entryHandle);
// @ts-expect-error Private card values are not public client contracts.
import type { VaultCardValue as PublicCardValue } from 'handrail-agent-sdk';

import { createVaultRequestExecutor } from 'handrail-agent-sdk/server';
import type { VaultHttpClient, VaultRequestRecipe } from 'handrail-agent-sdk/server';
declare const approvedHttpClient: VaultHttpClient;
declare const requestRecipe: VaultRequestRecipe<{ token: string }>;
const requestExecutor: TrustedVaultExecutor<{ token: string }> = createVaultRequestExecutor(requestRecipe, approvedHttpClient);
void createVaultUse(vaultUseHost, vaultUsePort, [requestExecutor]);
// @ts-expect-error HTTP client and recipe registration are server-only.
import type { VaultHttpClient as PublicHttpClient } from 'handrail-agent-sdk';
// @ts-expect-error HTTP execution still accepts only a bound operation and fence.
vaultUse.execute({ ...vaultRequest, headers: { authorization: 'model-input' } }, leaseFence);
