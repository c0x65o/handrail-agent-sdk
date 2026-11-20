import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createHandrailDelegatedFeedbackObserver,
  feedbackSubject,
  type FeedbackObservationGrant,
} from "../../server/handrail-feedback.js";
import { parseConversationEvent, type ConversationId } from "../conversation/events.js";
import {
  PostgresAiPersistence,
  PostgresConversationEventStore,
  PostgresPersistenceConflictError,
  type PostgresSqlClient,
} from "../postgres/index.js";
import type { FeedbackContext, FeedbackReceipt, FeedbackKind } from "./feedback.js";
import type { FeedbackRuntime } from "./feedback-session.js";
import type { JsonObject } from "../protocol.js";

export const hash = (parts: readonly unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export interface FeedbackWatch extends FeedbackContext {
  conversationId: string;
  grant: FeedbackObservationGrant;
}
interface Watch extends FeedbackWatch {
  state: "available" | "pending" | "following" | "unavailable" | "stopped" | "revoked";
  next: number;
  lastSuccess: number | null;
  digest: string | null;
}
export interface FeedbackFreshness {
  readonly state: Watch["state"] | "expired" | "stale";
  readonly lastSuccessfulRefresh: number | null;
}
export type CheckDelivery = (
  watch: FeedbackWatch,
  signal: AbortSignal,
  transaction?: PostgresSqlClient,
) => Promise<boolean>;
export type ReadGrant = (grant: FeedbackObservationGrant, signal: AbortSignal) => Promise<unknown>;

export class FeedbackWatches {
  constructor(
    private db: PostgresAiPersistence,
    private namespace: string,
    private runtime: FeedbackRuntime,
    private authorize: CheckDelivery,
    private read: ReadGrant,
  ) {}
  private key(context: FeedbackContext, conversation: string, kind: FeedbackKind, report: string) {
    return {
      tenantId: context.tenantId,
      kind: "feedback_watch" as const,
      scopeId: this.namespace,
      recordId: hash([context.scopeId, context.principalId, conversation, kind, report]),
    };
  }
  async remember(
    context: FeedbackContext,
    conversationId: string,
    external: string,
    receipt: FeedbackReceipt,
  ) {
    const key = this.key(context, conversationId, receipt.kind, receipt.reportId);
    const value: Watch = {
      tenantId: context.tenantId,
      scopeId: context.scopeId,
      principalId: context.principalId,
      conversationId,
      state: "available",
      next: 0,
      lastSuccess: null,
      digest: null,
      grant: {
        id: randomUUID(),
        kind: receipt.kind,
        report_id: receipt.reportId,
        cancelled: false,
        expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
        binding: {
          project_id: this.runtime.projectId,
          service_env_id: this.runtime.serviceEnvId,
          environment: this.runtime.environment,
          user_ref: context.principalId,
          tenant_ref: context.tenantId,
          conversation_id: external,
        },
      },
    };
    try {
      await this.db.compareAndSetDocument({ ...key, expectedVersion: null, value });
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
    }
  }
  private async load(context: FeedbackContext, conversation: string, kind: FeedbackKind, report: string) {
    const key = this.key(context, conversation, kind, report);
    const doc = await this.db.getDocument<Watch>(key.tenantId, key.kind, key.scopeId, key.recordId);
    if (!doc) throw new Error("Open the original report conversation");
    return { key, doc, watch: doc.value };
  }
  async status(
    context: FeedbackContext,
    conversation: string,
    kind: FeedbackKind,
    report: string,
  ): Promise<FeedbackFreshness> {
    const { watch } = await this.load(context, conversation, kind, report);
    return {
      lastSuccessfulRefresh: watch.lastSuccess,
      state:
        watch.state === "stopped" || watch.state === "revoked"
          ? watch.state
          : Date.parse(watch.grant.expires_at) <= Date.now()
            ? "expired"
            : watch.state === "following" && (!watch.lastSuccess || Date.now() - watch.lastSuccess > 120000)
              ? "stale"
              : watch.state,
    };
  }
  /** Server migration only. Legacy hosts bound grants to the literal conversation ID. */
  async adopt(
    context: FeedbackContext,
    conversationId: string,
    grant: FeedbackObservationGrant,
    signal: AbortSignal,
  ) {
    const expected = {
      project_id: this.runtime.projectId,
      service_env_id: this.runtime.serviceEnvId,
      environment: this.runtime.environment,
      tenant_ref: context.tenantId,
      user_ref: context.principalId,
      conversation_id: conversationId,
    };
    if (
      !isDeepStrictEqual(grant.binding, expected) ||
      grant.cancelled ||
      !(Date.parse(grant.expires_at) > Date.now())
    )
      throw new Error("Legacy grant does not match this conversation and runtime");
    const watch: Watch = {
      tenantId: context.tenantId,
      scopeId: context.scopeId,
      principalId: context.principalId,
      conversationId,
      grant,
      state: "following",
      next: 0,
      lastSuccess: null,
      digest: null,
    };
    if (!(await this.authorize(watch, signal))) throw new Error("Legacy observation access denied");
    const response = (await this.read(grant, signal)) as {
      contract_version: string;
      observation: unknown;
      record: { id: string };
    };
    if (
      response.contract_version !== "v1" ||
      !isDeepStrictEqual(response.observation, grant) ||
      response.record.id !== grant.report_id
    )
      throw new Error("Unverified legacy grant");
    const key = this.key(context, conversationId, grant.kind, grant.report_id);
    try {
      await this.db.compareAndSetDocument({ ...key, expectedVersion: null, value: watch });
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      const { watch: existing } = await this.load(context, conversationId, grant.kind, grant.report_id);
      if (!isDeepStrictEqual(existing.grant, grant)) throw new Error("Conflicting saved feedback grant");
    }
  }
  async follow(
    context: FeedbackContext,
    conversation: string,
    kind: FeedbackKind,
    report: string,
    stop: boolean,
    intent: string,
    call: (args: JsonObject) => Promise<JsonObject>,
  ) {
    const { key } = await this.load(context, conversation, kind, report);
    const commandKey = {
      ...key,
      kind: "feedback_command" as const,
      recordId: hash([context.principalId, context.scopeId, conversation, kind, stop, intent]),
    };
    const { grant, skipRemote, existingState } = await this.db.client.transaction(async (tx) => {
      const db = new PostgresAiPersistence(tx);
      const document = await db.getDocument<Watch>(key.tenantId, key.kind, key.scopeId, key.recordId);
      if (!document) throw new Error("Original report conversation is missing");
      const watch = document.value;
      const command = await db.getDocument<{ grantId: string; skipRemote: boolean }>(
        key.tenantId,
        commandKey.kind,
        key.scopeId,
        commandKey.recordId,
      );
      const inactive =
        ["stopped", "revoked"].includes(watch.state) || Date.parse(watch.grant.expires_at) <= Date.now();
      if (command && (command.value.grantId !== watch.grant.id || (!stop && inactive)))
        throw new Error("Follow-up intent was superseded");
      const grant =
        !stop && inactive
          ? {
              ...watch.grant,
              id: randomUUID(),
              expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
            }
          : watch.grant;
      const skipRemote = command?.value.skipRemote ?? (stop && watch.state === "available");
      if (!command)
        await db.compareAndSetDocument({
          ...commandKey,
          expectedVersion: null,
          value: { grantId: grant.id, conversationId: conversation, skipRemote },
        });
      // A prior start may already have reached Handrail. Only the worker reads
      // that exact grant to settle it, including a retry under another intent.
      if (!stop && !inactive && watch.state !== "available")
        return { grant, skipRemote, existingState: watch.state };
      const state = stop ? "stopped" : "pending";
      if (state !== watch.state || grant !== watch.grant)
        await db.compareAndSetDocument({
          ...key,
          expectedVersion: document.version,
          value: { ...watch, grant, state, next: 0 },
        });
      return { grant, skipRemote };
    });
    if (existingState) return { [existingState]: true };
    if (skipRemote) return { stopped: true };
    const response = await call({
      request_id: report,
      id: grant.id,
      binding: { ...grant.binding },
      ...(stop ? {} : { expires_at: grant.expires_at, follow_up_requested: true }),
    });
    if (
      response.contract_version !== "v1" ||
      !isDeepStrictEqual(response.observation, { ...grant, cancelled: stop })
    )
      throw new Error("Unverified feedback observation");
    if (!stop) {
      const { doc, watch } = await this.load(context, conversation, kind, report);
      if (watch.grant.id !== grant.id || Date.parse(grant.expires_at) <= Date.now() || ["stopped", "revoked"].includes(watch.state))
        throw new Error("Follow-up superseded");
      if (watch.state !== "following")
        await this.db.compareAndSetDocument({
          ...key,
          expectedVersion: doc.version,
          value: { ...watch, state: "following", next: 0 },
        });
    }
    return stop ? { stopped: true } : { following: true };
  }
  async refresh(signal: AbortSignal) {
    const due = await this.db.client.query<{
      tenant_id: string;
      record_id: string;
      version: number;
      payload: Watch;
    }>(
      `
      SELECT tenant_id,record_id,version,payload FROM handrail_ai_documents WHERE kind='feedback_watch' AND scope_id=$1
      AND payload->>'state' IN ('pending','following','unavailable') AND (payload->>'next')::bigint <= $2
      AND (payload->'grant'->>'expires_at')::timestamptz > now()
      ORDER BY (payload->>'next')::bigint,tenant_id,record_id LIMIT 8`,
      [this.namespace, Date.now()],
    );
    for (const row of due.rows) {
      signal.throwIfAborted();
      const watch = row.payload,
        grant = watch.grant;
      const key = {
        tenantId: row.tenant_id,
        kind: "feedback_watch" as const,
        scopeId: this.namespace,
        recordId: row.record_id,
      };
      const expectedVersion = Number(row.version);
      let text: string | undefined,
        digest: string | null = null;
      let state: Watch["state"] = "following";
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
      try {
        if (!(await this.authorize(watch, timeout))) state = "revoked";
        else {
          const subjectRef = feedbackSubject({ kind: grant.kind, id: grant.report_id });
          const observer = createHandrailDelegatedFeedbackObserver({
            now: Date.now,
            load: async () => grant,
            read: async (g, s) => {
              const response = (await this.read(g, s)) as {
                record: {
                  status: string;
                  information_request?: {
                    information_request_id: string;
                    current_behavior?: string;
                    question: string;
                    options: string[];
                  } | null;
                };
              };
              const r = response.record,
                q = r.information_request;
              if (
                typeof r.status !== "string" ||
                (q &&
                  (typeof q.question !== "string" ||
                    (q.current_behavior != null && typeof q.current_behavior !== "string") ||
                    typeof q.information_request_id !== "string" ||
                    !Array.isArray(q.options) ||
                    !q.options.every((x) => typeof x === "string")))
              )
                throw new Error("Invalid observation projection");
              text = [
                `${grant.kind} ${grant.report_id} — ${r.status}`,
                ...(q?.current_behavior?.trim() ? ["What it does today", q.current_behavior] : []),
                ...(q ? ["Needs your input", q.question, ...q.options] : []),
              ].join("\n");
              digest = hash([text, q?.information_request_id]);
              return response;
            },
          });
          await observer.read(
            {
              id: grant.id,
              scope: {
                tenantRef: watch.tenantId,
                userRef: watch.principalId,
                accountRef: watch.scopeId,
                projectRef: grant.binding.project_id,
                environmentRef: grant.binding.service_env_id,
                purposeRef: "feedback",
              },
            },
            {
              kind: "watch",
              adapterRef: "feedback",
              subjectRef,
              contentRef: grant.id,
              pollMs: 60000,
              maxAgeMs: 60000,
              expiresAt: Date.parse(grant.expires_at),
            },
            timeout,
          );
        }
      } catch (error) {
        const failure = error as { status?: number; code?: string } | null;
        if (watch.state === "pending") {
          // An absent grant can return the same 403 as a mismatched binding.
          // Neither proves creation or revocation. Keep its identity until expiry.
          state = failure?.status === 410 || failure?.code === "feedback_observation_identity_revoked"
            ? "revoked" : "pending";
        } else {
          state = [401, 403, 404, 410].includes(Number(failure?.status)) ? "revoked" : "unavailable";
        }
      }
      signal.throwIfAborted();
      try {
        await this.db.client.transaction(async (tx) => {
          const db = new PostgresAiPersistence(tx);
          if (Date.parse(grant.expires_at) <= Date.now()) return;
          if (state === "following") {
            try {
              if (!(await this.authorize(watch, timeout, tx))) state = "revoked";
              timeout.throwIfAborted();
            } catch {
              state = watch.state === "pending" ? "pending" : "unavailable";
            }
          }
          signal.throwIfAborted();
          const now = Date.now();
          await db.compareAndSetDocument({
            ...key,
            expectedVersion,
            value: {
              ...watch,
              state,
              next: now + 60000,
              lastSuccess: state === "following" ? now : watch.lastSuccess,
              digest: state === "following" ? digest : watch.digest,
            },
          });
          if (state !== "following" || !text || digest === watch.digest) return;
          const events = new PostgresConversationEventStore(db, watch.tenantId);
          const conversationId = watch.conversationId as ConversationId;
          const latest = await events.getLatestRevision(conversationId);
          const id = randomUUID(),
            occurred = new Date(now).toISOString();
          const appended = await events.append({
            conversationId,
            expectedRevision: latest,
            events: [
              parseConversationEvent({
                version: 1,
                event_id: id,
                conversation_id: conversationId,
                revision: (latest ?? 0) + 1,
                occurred_at: occurred,
                actor: { type: "assistant" },
                source: { type: "runtime" },
                payload: {
                  type: "message.created",
                  message_id: id,
                  role: "assistant",
                  content: [{ type: "text", text }],
                },
              }),
            ],
          });
          if (appended.status !== "appended") throw new PostgresPersistenceConflictError();
          const previous = await db.getDocument<
            import("../conversation/activity.js").ConversationActivityRecord
          >(watch.tenantId, "activity", watch.scopeId, conversationId);
          await db.compareAndSetDocument({
            tenantId: watch.tenantId,
            kind: "activity",
            scopeId: watch.scopeId,
            recordId: conversationId,
            expectedVersion: previous?.version ?? null,
            value: {
              turnStatus: "idle",
              ...previous?.value,
              conversationId,
              unread: true,
              updatedAt: occurred,
              summary: text.slice(0, 240),
            },
          });
        });
      } catch (error) {
        if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      }
    }
  }
}
