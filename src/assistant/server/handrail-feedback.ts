import { isDeepStrictEqual } from "node:util";
import { createFeedbackTools, type FeedbackContext, type FeedbackKind } from "./feedback.js";
import { createToolPlugin } from "../tools/plugin.js";
import { parseToolDefinition, type JsonObject } from "../protocol.js";
import type {
  ApplicationToolAdmission,
  ApplicationToolExecutor,
  ApplicationToolExecutionLocation,
} from "../tools/executor.js";
import { PostgresPersistenceConflictError, type PostgresAiPersistence } from "../postgres/index.js";
import {
  catalog,
  nameFor,
  openSession,
  reporterConfig,
  type Operation,
  type FeedbackRuntime,
  type FeedbackReporters,
} from "./feedback-session.js";
import { FeedbackWatches, hash, type CheckDelivery } from "./feedback-watches.js";

export type { FeedbackFreshness, FeedbackWatch } from "./feedback-watches.js";
export type { FeedbackRuntime, FeedbackReporters } from "./feedback-session.js";

export interface HandrailFeedbackOptions<C extends FeedbackContext> {
  readonly runtime: FeedbackRuntime;
  readonly persistence: PostgresAiPersistence;
  readonly installationId: string;
  readonly reporters: () => Promise<FeedbackReporters>;
  readonly currentSession: (
    context: C,
    signal: AbortSignal,
  ) => Promise<(FeedbackContext & { sessionToken: string }) | null>;
  readonly authorize: (
    context: C,
    kind: FeedbackKind,
    op: Operation,
    signal: AbortSignal,
    conversationId?: string,
  ) => Promise<boolean>;
  /** Return the same trusted user intent on exact retries. For follow_up require explicit user opt-in. */
  readonly resolveIntent: (
    context: C,
    location: ApplicationToolExecutionLocation,
    kind: FeedbackKind,
    op: Operation,
    signal: AbortSignal,
    args?: JsonObject,
  ) => Promise<string>;
  readonly authorizeDelivery: CheckDelivery;
}
const object = (v: unknown): JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : {};
const fields: Record<Operation, readonly string[]> = {
  submit: ["title", "description", "impact", "reproducer", "route", "app_version", "priority", "context"],
  list: ["limit", "cursor", "offset", "search", "sort", "status_group", "visibility"],
  lookup: ["request_id"],
  answer: ["request_id", "information_request_id", "option", "answer"],
  follow_up: ["request_id", "follow_up_requested"],
  stop_follow_up: ["request_id"],
};

function reviewStatus(kind: FeedbackKind, receipt: JsonObject) {
  if (kind === "bug") {
    if (receipt.analysis_resumed === true) return "resumed";
    return receipt.analysis_resumed === false ? "needs_recovery" : "unverified";
  }
  if (receipt.warning || receipt.assessment_status === "blocked") return "needs_recovery";
  if (receipt.assessment_status === "queued") return "queued";
  return ["running", "succeeded"].includes(String(receipt.assessment_status)) ? "resumed" : "unverified";
}

export function createHandrailFeedback<C extends FeedbackContext>(host: HandrailFeedbackOptions<C>) {
  const runtime = Object.freeze({ ...host.runtime });
  const { persistence } = host;
  if (
    !host.installationId ||
    !runtime.projectId ||
    !runtime.serviceEnvId ||
    !["dev", "staging", "production"].includes(runtime.environment)
  )
    throw new TypeError("Handrail Feedback requires an exact installation and runtime");
  const binding = hash([host.installationId, runtime.projectId, runtime.serviceEnvId, runtime.environment]);
  const session = async (c: C, s: AbortSignal) =>
    openSession(c, s, runtime, await host.reporters(), await host.currentSession(c, s));
  const watches = new FeedbackWatches(
    persistence,
    `feedback-${binding}`,
    runtime,
    host.authorizeDelivery,
    async (grant, signal) => {
      const { createFeedbackObservationClient } = await import("@handrail/mcp/feedback");
      const config = reporterConfig(runtime, await host.reporters());
      const transport = config.fetch ?? fetch;
      return createFeedbackObservationClient({
        env: {},
        config: {
          ...config,
          fetch: (url: RequestInfo | URL, init?: RequestInit) =>
            transport(url, {
              ...init,
              signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
            }),
        },
      }).read(grant);
    },
  );
  const submit = createFeedbackTools<C>(
    {
      persistence,
      binding,
      enabled: () => true,
      openSession: session,
      authorize: (c, k, s, l) => host.authorize(c, k, "submit", s, l?.conversationId),
      resolveIntent: (c, l, k, s, args) => host.resolveIntent(c, l, k, "submit", s, args),
    },
    { environment: runtime.environment, submitted: watches.remember.bind(watches) },
  );
  const check = async (c: C, kind: FeedbackKind, op: Operation, s: AbortSignal, conversation?: string) => {
    s.throwIfAborted();
    if (!(await host.authorize(c, kind, op, s, conversation))) throw new Error("Feedback access denied");
  };
  const plugin = createToolPlugin<ApplicationToolExecutor<C>, C, C, C>({
    pluginId: "handrail.feedback.history",
    version: "1.0.0",
    displayName: "Handrail Feedback",
    registrations: async (context) => {
      const signal = new AbortController().signal;
      const active = await session(context, signal).catch(() => null);
      if (!active) return [];
      try {
        const registrations = [];
        for (const tool of active.tools) {
          const item = catalog.get(tool.name);
          if (!item || item.op === "submit" || !(await host.authorize(context, item.kind, item.op, signal)))
            continue;
          const { kind, op } = item;
          const properties = Object.fromEntries(
            Object.entries(tool.inputSchema.properties ?? {}).filter(([k]) => fields[op].includes(k)),
          );
          const definition = parseToolDefinition({
            name: tool.name,
            description: tool.description ?? tool.name,
            input_schema: {
              type: "object",
              properties,
              additionalProperties: false,
              required: (Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []).filter(
                (k) => typeof k === "string" && Object.hasOwn(properties, k),
              ),
            },
          });
          const same = (c: C) =>
            c.tenantId === context.tenantId &&
            c.scopeId === context.scopeId &&
            c.principalId === context.principalId;
          const executor: ApplicationToolExecutor<C> = async (args, e) => {
            const c = e.applicationContext,
              s = e.signal,
              l = e.location;
            if (
              !same(c) ||
              e.definition.name !== tool.name ||
              !l ||
              Object.keys(args).some((k) => !Object.hasOwn(properties, k))
            )
              throw new Error("Invalid feedback dispatch");
            await check(c, kind, op, s, l.conversationId);
            const fresh = await session(c, s);
            try {
              const call = async (name: string, input: JsonObject) => {
                await check(c, kind, op, s, l.conversationId);
                const result = object(
                  await fresh.callTool({ name, arguments: input, toolCallId: e.toolCallId, signal: s }),
                );
                if (!result.structuredContent || result.isError)
                  throw new Error("Unconfirmed feedback operation");
                const { connector: _, ...receipt } = object(result.structuredContent);
                await check(c, kind, op, s, l.conversationId);
                return receipt;
              };
              const report = args.request_id;
              if (op === "list" || op === "lookup") return await call(tool.name, args);
              if (typeof report !== "string") throw new Error("Report ID required");
              const intent = await host.resolveIntent(c, l, kind, op, s, args);
              if (!intent?.trim()) throw new Error("Explicit feedback intent required");
              if (op !== "answer") {
                if (op === "follow_up" && args.follow_up_requested !== true)
                  throw new Error("Explicit follow-up required");
                return await watches.follow(
                  c,
                  l.conversationId,
                  kind,
                  report,
                  op === "stop_follow_up",
                  intent,
                  (input) => call(tool.name, input),
                );
              }
              const frozen = {
                conversationId: l.conversationId,
                request_id: report,
                information_request_id: args.information_request_id,
                option: args.option ?? null,
                answer: args.answer ?? null,
              };
              if (typeof frozen.information_request_id !== "string" || !(frozen.option || frozen.answer))
                throw new Error("Question and answer required");
              const key = {
                tenantId: c.tenantId,
                kind: "feedback_answer" as const,
                scopeId: `feedback-answer-${binding}`,
                recordId: hash([c.scopeId, c.principalId, l.conversationId, kind, intent]),
              };
              const saved = await persistence.getDocument<typeof frozen>(
                key.tenantId,
                key.kind,
                key.scopeId,
                key.recordId,
              );
              if (saved && !isDeepStrictEqual(saved.value, frozen))
                throw new Error("Feedback answer intent conflict");
              const lookup = await call(nameFor(kind, "lookup"), { request_id: report });
              const record = lookup;
              const question = object(record.information_request);
              if (record.id !== report) throw new Error("Feedback report mismatch");
              if (!saved || question.information_request_id === frozen.information_request_id) {
                if (
                  question.information_request_id !== frozen.information_request_id ||
                  question.response_allowed === false ||
                  (frozen.option &&
                    (!Array.isArray(question.options) || !question.options.includes(frozen.option)))
                )
                  throw new Error("Refresh the report and ask the user about the current question");
              }
              if (!saved) {
                try {
                  await persistence.compareAndSetDocument({ ...key, expectedVersion: null, value: frozen });
                } catch (error) {
                  if (!(error instanceof PostgresPersistenceConflictError)) throw error;
                  const winner = await persistence.getDocument(
                    key.tenantId,
                    key.kind,
                    key.scopeId,
                    key.recordId,
                  );
                  if (!isDeepStrictEqual(winner?.value, frozen))
                    throw new Error("Feedback answer intent conflict");
                }
              }
              const receipt = await call(tool.name, args);
              if (
                receipt.answered !== true ||
                receipt.information_request_id !== frozen.information_request_id ||
                (kind === "bug" && receipt.bug_id !== report)
              )
                throw new Error("Unverified answer receipt");
              return { ...receipt, resumption: reviewStatus(kind, receipt) };
            } finally {
              await fresh.close();
            }
          };
          registrations.push({ definition, discover: same, executor });
        }
        return registrations;
      } finally {
        await active.close();
      }
    },
  });
  const admission: ApplicationToolAdmission<C> = async (input) => {
    const item = catalog.get(input.definition.name);
    if (!item) return { outcome: "deny" };
    if (item.op === "submit") return submit.admission(input);
    try {
      await check(input.applicationContext, item.kind, item.op, input.signal, input.location?.conversationId);
      const current = await session(input.applicationContext, input.signal);
      try {
        return { outcome: current.tools.some((t) => t.name === input.definition.name) ? "allow" : "deny" };
      } finally {
        await current.close();
      }
    } catch {
      return { outcome: "deny" };
    }
  };
  return {
    plugins: [submit.plugin, plugin],
    admission,
    owns: (name: string) => catalog.has(name),
    adoptLegacyGrant: watches.adopt.bind(watches),
    reconcile: submit.reconcile,
    refresh: watches.refresh.bind(watches),
    async status(c: C, conversation: string, k: FeedbackKind, report: string, signal: AbortSignal) {
      await check(c, k, "lookup", signal, conversation);
      return watches.status(c, conversation, k, report);
    },
  };
}
