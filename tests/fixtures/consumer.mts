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
  // @ts-expect-error Browser fill never accepts specialized payment references.
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
