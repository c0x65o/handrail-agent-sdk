import { assistanceDigest } from './assistance.js';
import type { AssistanceKey, AssistanceObservation, AssistanceSpec, ObservationAdapter } from './assistance.js';
import type { EffectAdapter, EffectRequest } from './effects.js';

export type HandrailFeedbackKind = 'bug' | 'enhancement';
export interface CanonicalFeedback { readonly kind: HandrailFeedbackKind; readonly id: string }
/** Existing MCP v2 catalog operations. Deliberately excludes the developer
 * Work Request bridge. Question/approval response operations are not present
 * in this catalog and must never be silently mapped to developer.clarify. */
export const handrailFeedbackOperations = {
  discover: 'handrail_feedback_v2_discover',
  bug: { submit: 'handrail_bug_reporter_v1_submit', lookup: 'handrail_bug_reporter_v1_lookup' },
  enhancement: { submit: 'handrail_enhancement_reporter_v1_submit', lookup: 'handrail_enhancement_reporter_v1_lookup',
    releaseStatus: 'handrail_enhancement_reporter_v1_release_status' },
} as const;
export interface HandrailFeedbackClient {
  /** Return parsed structuredContent from the existing MCP tool response.
   * A failed/isError response must throw. No text scraping or invented IDs. */
  call(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface HandrailFeedbackSession {
  /** Resolve fresh Known User identity and exact-runtime reporter credentials,
   * and hold current authorization through the callback. Never persist tokens. */
  withClient<T>(key: AssistanceKey, run: (client: HandrailFeedbackClient) => Promise<T>): Promise<T>;
}
export interface FeedbackObservationGrant {
  readonly id: string;
  readonly kind: HandrailFeedbackKind;
  readonly report_id: string;
  readonly binding: { readonly project_id: string; readonly service_env_id: string; readonly environment: string;
    readonly tenant_ref: string; readonly user_ref: string; readonly conversation_id: string };
  readonly expires_at: string;
  readonly cancelled: boolean;
}

/** A foreground-admitted grant is a separate authority from Known User sessions.
 * The host checks current membership and original-conversation existence on
 * every operation. Handrail checks current runtime credentials/source membership.
 * Reuses Assistance's durable scheduling, expiry, cancellation and fact dedupe. */
export function createHandrailDelegatedFeedbackObserver(deps: {
  readonly now: () => number;
  readonly load: (key: AssistanceKey) => Promise<FeedbackObservationGrant>;
  readonly read: (grant: FeedbackObservationGrant, signal: AbortSignal) => Promise<unknown>;
}): ObservationAdapter {
  return { async read(key, spec, signal) {
    const grant = await deps.load(key);
    const feedback = parseSubject(spec.subjectRef);
    if (grant.kind !== feedback.kind || grant.report_id !== feedback.id
      || grant.binding.tenant_ref !== key.scope.tenantRef || grant.binding.user_ref !== key.scope.userRef
      || grant.binding.service_env_id !== key.scope.environmentRef || grant.cancelled
      || !Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= deps.now()) throw Error('feedback_observation_scope_denied');
    const raw = object(await deps.read(grant, signal));
    const returned = object(raw.observation);
    if (raw.contract_version !== 'v1' || assistanceDigest(returned) !== assistanceDigest(grant)) throw Error('feedback_observation_identity_mismatch');
    signal.throwIfAborted();
    if (Date.parse(grant.expires_at) <= deps.now()) throw Error('feedback_observation_expired');
    const record = object(raw.record);
    if (record.id !== feedback.id) throw Error('feedback_identity_mismatch');
    const status = canonicalFeedbackReady(feedback, record, null, grant.binding.environment) ? 'matched'
      : ['cancelled','declined','closed','wont_fix','not_reproduced'].includes(record.status) ? 'cancelled'
        : record.status_group === 'needs_attention' || record.resolution_journey?.approval_required === true ? 'needs_input' : 'pending';
    return { subjectRef: spec.subjectRef, observedAt: deps.now(), status,
      evidenceRef: `feedback:${assistanceDigest([grant.id, status, record])}`, detailRef: feedbackSubject(feedback) };
  } };
}
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const id = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v)) throw Error('invalid_canonical_feedback');
  return v;
};
async function discover(client: HandrailFeedbackClient, kind: HandrailFeedbackKind, signal: AbortSignal) {
  const d = object(await client.call(handrailFeedbackOperations.discover, {}, signal));
  if (d.contract_version !== 'v2' || d.principal?.authenticated !== true
    || d.principal?.source !== 'verified_known_user_discovery' || d.reporters?.[kind]?.ready !== true) throw Error('feedback_unavailable');
}
export function feedbackSubject(feedback: CanonicalFeedback): string {
  if (!['bug', 'enhancement'].includes(feedback.kind)) throw Error('invalid_feedback_kind');
  return `${feedback.kind}:${id(feedback.id)}`;
}
function parseSubject(subject: string): CanonicalFeedback {
  const separator = subject.indexOf(':');
  const kind = subject.slice(0, separator);
  if (kind !== 'bug' && kind !== 'enhancement') throw Error('invalid_feedback_subject');
  return { kind, id: id(subject.slice(separator + 1)) };
}
/** Honest readiness: only canonical, environment-matched verified delivery.
 * Worker success, build/check milestones, or a rollout alone are insufficient. */
export function canonicalFeedbackReady(feedback: CanonicalFeedback, record: unknown, release: unknown, environment: string): boolean {
  const r = object(record), delivery = object(release);
  if (r.id !== feedback.id) return false;
  if (feedback.kind === 'bug') {
    const status = object(r.status_rollup), journey = object(r.resolution_journey);
    return status.stage === 'deployed' && status.environment === environment
      && status.reverification_status === 'passed' && typeof status.version === 'string' && !!status.version
      && journey.release_environment === environment && journey.outcome === 'resolved'
      && Array.isArray(journey.milestones) && journey.milestones.some((m: any) => m.key === 'confirmed_resolved' && m.state === 'complete');
  }
  const journey = object(r.delivery_journey);
  const tracking = object(delivery.release_tracking ?? r.release_tracking);
  const env = Array.isArray(tracking.environments) ? tracking.environments.find((e: any) => e.environment === environment) : null;
  return journey.contract_version === 2 && journey.verification_status === 'passed'
    && journey.verification_environment === environment && journey.verified_environment === environment
    && journey.released_environment === environment && env?.deployment_state === 'fully_deployed'
    && Array.isArray(env.targets) && env.targets.length > 0 && env.targets.every((t: any) => t.contains_change === true);
}

/** Fits directly into createAssistance.adapters. Persist canonical kind/id as
 * subjectRef. Polling and notification deduplication belong to createAssistance.
 * Canonical questions/approvals remain needs_input until Handrail resolves them;
 * this adapter does not invent an answer or grant release authority. */
export function createHandrailFeedbackObserver(deps: HandrailFeedbackSession & {
  readonly now: () => number;
  readonly environment: string;
}): ObservationAdapter {
  return {
    read(key: AssistanceKey, spec: Extract<AssistanceSpec, { kind: 'watch' }>, signal: AbortSignal) {
      const feedback = parseSubject(spec.subjectRef);
      return deps.withClient(key, async client => {
        await discover(client, feedback.kind, signal);
        const raw = object(await client.call(handrailFeedbackOperations[feedback.kind].lookup, { request_id: feedback.id }, signal));
        if (feedback.kind === 'enhancement' && raw.contract_version !== 'v1') throw Error('feedback_contract_mismatch');
        const record = object(raw.request ?? raw.bug ?? raw);
        if (record.id !== feedback.id) throw Error('feedback_identity_mismatch');
        const release = feedback.kind === 'enhancement'
          ? await client.call(handrailFeedbackOperations.enhancement.releaseStatus, { request_id: feedback.id }, signal) : null;
        if (feedback.kind === 'enhancement' && (object(release).contract_version !== 'v1'
          || object(release).request_id !== feedback.id)) throw Error('feedback_release_identity_mismatch');
        signal.throwIfAborted();
        const ready = canonicalFeedbackReady(feedback, record, release, deps.environment);
        const needsInput = record.status_group === 'needs_attention' || record.resolution_journey?.approval_required === true;
        const closed = ['cancelled', 'declined', 'closed', 'wont_fix', 'not_reproduced'].includes(record.status);
        const status = ready ? 'matched' : needsInput ? 'needs_input' : closed ? 'cancelled' : 'pending';
        const evidenceRef = `feedback:${assistanceDigest([feedback, status, record.updated_at ?? null, release])}`;
        return { subjectRef: spec.subjectRef, observedAt: deps.now(), status, evidenceRef,
          detailRef: feedbackSubject(feedback) } satisfies AssistanceObservation;
      });
    },
  };
}

export interface FeedbackSubmission {
  readonly key: AssistanceKey;
  readonly kind: HandrailFeedbackKind;
  /** Validated through the CURRENT MCP catalog's schema and owner approval.
   * SDK overwrites the deduplication key; never accept execution controls. */
  readonly input: Readonly<Record<string, unknown>>;
}
export interface FeedbackReceipt {
  readonly canonical: CanonicalFeedback;
  readonly receiptRef: string;
}
/** Adapt the existing effect store rather than create another submission
 * ledger. Request binding/private inputs and receipts use host-owned storage. */
export function createHandrailFeedbackEffectAdapter(deps: HandrailFeedbackSession & {
  readonly load: (request: EffectRequest) => Promise<FeedbackSubmission>;
  readonly receipt: (request: EffectRequest) => Promise<FeedbackReceipt | null>;
  readonly save: (request: EffectRequest, receipt: FeedbackReceipt) => Promise<void>;
  /** Prove no in-flight/prior dispatch can apply. A list miss is NOT proof.
   * Without such proof, uncertain submission stays unknown for reconciliation.
   * This may return true for a freshly admitted intent with a host-owned fence. */
  readonly notApplied: (request: EffectRequest) => Promise<boolean>;
}): EffectAdapter {
  return {
    async reconcile(request) {
      const receipt = await deps.receipt(request);
      if (receipt) return { outcome: 'verified', receiptRef: receipt.receiptRef };
      return await deps.notApplied(request) ? { outcome: 'not_applied', evidenceRef: `absent:${assistanceDigest(request)}` } : { outcome: 'unknown' };
    },
    async dispatch(request, signal) {
      const submission = await deps.load(request);
      if (assistanceDigest(submission.key.scope) !== assistanceDigest(request.identity.host)) throw Error('feedback_scope_mismatch');
      return deps.withClient(submission.key, async client => {
        await discover(client, submission.kind, signal);
        const key = submission.kind === 'bug' ? 'event_id' : 'idempotency_key';
        const allowed = submission.kind === 'bug'
          ? ['title', 'description', 'impact', 'reproducer', 'route', 'app_version']
          : ['external_conversation_id', 'title', 'description', 'priority', 'context'];
        if (Object.keys(submission.input).some(k => !allowed.includes(k))) throw Error('invalid_feedback_submission');
        const raw = object(await client.call(handrailFeedbackOperations[submission.kind].submit,
          { ...submission.input, [key]: request.idempotencyRef }, signal));
        const canonical = { kind: submission.kind, id: id(submission.kind === 'bug' ? raw.bugId ?? raw.bug_id : raw.request?.id ?? raw.request_id) };
        const receiptRef = `feedback:${assistanceDigest([request, canonical])}`;
        // Persist the canonical ID even if cancellation arrived during remote IO.
        // This records an observed fact; it does not authorize another action.
        await deps.save(request, { canonical, receiptRef });
        return { outcome: 'verified', receiptRef };
      });
    },
  };
}
