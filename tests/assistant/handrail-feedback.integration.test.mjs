import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { postgresFromClient } from "handrail-agent-sdk/assistant/persistence/postgres";
import { createHandrailFeedback } from "handrail-agent-sdk/assistant/server/feedback";

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

for (const kind of ["bug", "enhancement"])
  test(`${kind}: authenticated tools, durable answers and delegated notices`, async (t) => {
    const pg = new PGlite();
    t.after(() => pg.close());
    const adapt = (db) => ({
      query: async (sql, args) => {
        const r = await db.query(sql, args);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
      transaction: (fn) => fn(adapt(db)),
    });
    const { persistence } = postgresFromClient({
      ...adapt(pg),
      transaction: (fn) => pg.transaction((tx) => fn(adapt(tx))),
    });
    await persistence.migrate();
    const runtime = {
      projectId: randomUUID(),
      serviceEnvId: randomUUID(),
      environment: kind === "bug" ? "production" : "staging",
    };
    const context = { principalId: "user", tenantId: "tenant", scopeId: "scope" },
      location = { conversationId: "chat", turnId: "turn" };
    const report = randomUUID(),
      capability = randomUUID(),
      signal = new AbortController().signal;
    const question = {
      information_request_id: randomUUID(),
      question: "Which view?",
      options: ["Order", "Invoice"],
    };
    let open = question,
      grant,
      saved,
      starts = 0,
      loseAck = true,
      delayAck,
      observationStatus = 200,
      reads = 0,
      posted = 0,
      consent = true,
      intentVersion = 1,
      authorizedAtCommit = true;
    const record = () => ({
      id: report,
      environment:runtime.environment, submission_kind:kind,
      status: open ? "needs_clarification" : "review",
      information_request: open,
    });
    const host = {
      persistence,
      runtime,
      installationId: "test",
      currentSession: async (c) => ({ ...c, sessionToken: "private-session" }),
      authorize: async (c, k, op, s, conversation) =>
        c.principalId === "user" && (!conversation || conversation === "chat"),
      authorizeDelivery: async (_watch, _signal, tx) => !tx || authorizedAtCommit,
      resolveIntent: async (_context, _location, _kind, op) => {
        if (!consent) return "";
        return op === "submit" ? "original-submit" : op + intentVersion;
      },
      reporters: async () => ({
        bug: { apiBaseUrl: "https://fixture.invalid/api", reportToken: "private-token" },
        enhancement: {
          apiUrl: "https://fixture.invalid/api/enhancement-reporting/v1",
          token: "private-token",
          capabilityId: capability,
        },
        fetch: async (url, init) => {
          const u = new URL(url),
            p = u.pathname,
            b = JSON.parse(init.body ?? "{}");
          assert.equal(u.origin, "https://fixture.invalid");
          if (p.endsWith("/policy"))
            return json({
              schema_version: 1,
              project_id: runtime.projectId,
              environment: runtime.environment,
              reporter: { identity_verified: true },
              reporter_observations: { available: true },
            });
          if (p.endsWith("/discovery"))
            return json({
              contract_version: "v1",
              capability: {
                id: capability,
                project_id: runtime.projectId,
                service_env_id: runtime.serviceEnvId,
                environment: runtime.environment,
              },
              principal: { authenticated: true, authentication_method: "known_users_direct_session" },
              enhancement_reporting: { enabled: true, workflow: { clarification_response: true } },
              reporter_observations: { available: true },
            });
          if (p.endsWith("/read")) {
            reads++;
            assert.equal(p.split("/").at(-2), grant.id);
            assert.deepEqual(b.binding, grant.binding);
            return json({ contract_version: "v1", observation: grant, record: record() }, observationStatus);
          }
          if (p.endsWith("/cancel"))
            return json({ contract_version: "v1", observation: { ...grant, cancelled: true } });
          if (p.endsWith("/observations")) {
            starts++;
            grant = {
              id: b.id,
              report_id: report,
              kind,
              binding: b.binding,
              expires_at: b.expires_at,
              cancelled: false,
            };
            if (loseAck) throw new Error("Fixture lost the response after acceptance");
            const acknowledgement = json({ contract_version: "v1", observation: grant });
            await delayAck?.();
            return acknowledgement;
          }
          if (p.endsWith("/answer") || p.endsWith("/clarifications")) {
            const id = b.information_request_id ?? p.split("/").at(-2);
            assert.equal(id, question.information_request_id);
            if (saved) assert.deepEqual(b, saved);
            const replayed = !!saved;
            saved = b;
            open = null;
            return json({
              contract_version: "v1",
              answered: true,
              replayed,
              information_request_id: id,
              ...(kind === "bug"
                ? { bug_id: report, analysis_resumed: replayed ? null : false }
                : {
                    assessment_id: "assessment",
                    assessment_status: "blocked",
                    warning: { code: "needs_recovery" },
                  }),
            });
          }
          if (init.method === "POST") {
            posted++;
            return json(
              kind === "bug"
                ? { bug_id: report, event_id: b.event_id, reporter_identity: { verification_result: true } }
                : {
                    contract_version: "v1",
                    request: { id: report, submission_kind: "enhancement" },
                    replayed: false,
                  },
              201,
            );
          }
          if (p.endsWith(report))
            return json(kind === "bug" ? { bug: record() } : { ...record(), contract_version: "v1" });
          return json({ contract_version: "v1", items: [record()] });
        },
      }),
    };
    let feedback = createHandrailFeedback(host);
    const registrations = (await Promise.all(feedback.plugins.map((p) => p.registrations(context)))).flat();
    assert.equal(registrations.length, 12);
    const call = async (op, args = {}, override = {}) => {
      const name = `handrail_${kind}_reporter_v1_${op}`;
      const tool = registrations.find((r) => r.definition.name === name);
      return tool.executor(args, {
        definition: tool.definition,
        applicationContext: context,
        location,
        toolCallId: "fixture-call",
        signal,
        ...override,
      });
    };
    for (const suffix of ["archive", "cancel", "get_attachment", "release_status"]) {
      const definition = { name: `handrail_${kind}_reporter_v1_${suffix}` };
      assert.deepEqual(
        await feedback.admission({ definition, applicationContext: context, location, signal }),
        { outcome: "deny" },
      );
      await assert.rejects(call("lookup", { request_id: report }, { definition }));
    }
    const input = { title: "Offline fixture", description: "Fixture only" };
    const status = () => feedback.status(context, "chat", kind, report, signal);
    await pg.exec(`
      CREATE FUNCTION fixture_fail() RETURNS trigger AS $$BEGIN RAISE EXCEPTION 'fixture failure'; END$$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_remember BEFORE INSERT ON handrail_ai_documents FOR EACH ROW
        WHEN (NEW.kind='feedback_watch') EXECUTE FUNCTION fixture_fail()`);
    await assert.rejects(call("submit", input), /may have been accepted/);
    assert.equal(posted, 1);
    await assert.rejects(status(), /original report conversation/);
    await pg.exec("DROP TRIGGER fail_remember ON handrail_ai_documents");
    feedback = createHandrailFeedback(host);
    for (let i = 0; i < 2; i++)
      assert.deepEqual(await feedback.reconcile(context, location, kind, signal), { kind, reportId: report });
    assert.equal((await status()).state, "available");
    assert.equal(posted, 1, "repair reads the canonical receipt without resubmitting");
    assert.ok((await call("list")).items.length);
    assert.equal((await call("lookup", { request_id: report })).id, report);
    for (const c of [
      { ...context, scopeId: "other" },
      { ...context, tenantId: "other" },
      { ...context, principalId: "other" },
    ])
      await assert.rejects(call("lookup", { request_id: report }, { applicationContext: c }));
    const follow = { request_id: report, follow_up_requested: true };
    await assert.rejects(call("follow_up", follow, { location: { ...location, conversationId: "other" } }));
    consent = false;
    await assert.rejects(call("follow_up", follow));
    consent = true;
    await assert.rejects(call("follow_up", follow));
    assert.equal((await status()).state, "pending");
    assert.equal(starts, 1);
    await call("stop_follow_up", { request_id: report });
    const cancelledGrant = grant.id;
    feedback = createHandrailFeedback(host);
    await feedback.refresh(signal);
    assert.equal((await status()).state, "stopped");
    assert.equal(reads, 0);
    await assert.rejects(call("follow_up", follow), /superseded/);
    intentVersion++;
    await assert.rejects(call("follow_up", follow)); // a new explicit opt-in, accepted remotely
    assert.notEqual(grant.id, cancelledGrant);
    assert.deepEqual(await call("follow_up", follow), { pending: true });
    assert.equal(starts, 2);
    loseAck = false;
    feedback = createHandrailFeedback(host); // Same durable database, fresh worker.
    const due = () =>
      pg.query(
        "UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{next}','0') WHERE kind='feedback_watch'",
      );
    const notices = async () =>
      (await pg.query("SELECT payload FROM handrail_ai_events ORDER BY revision")).rows;
    for (const code of [503, 403, 404]) {
      observationStatus = code;
      await due();
      await feedback.refresh(signal);
      assert.equal((await status()).state, "pending");
      assert.equal((await notices()).length, 0);
    }
    observationStatus = 200;
    await due();
    // A failed event append must also roll back the receipt and unread index.
    await pg.exec(
      "CREATE TRIGGER fixture_fail BEFORE INSERT ON handrail_ai_events FOR EACH ROW EXECUTE FUNCTION fixture_fail()",
    );
    await assert.rejects(feedback.refresh(signal));
    assert.equal((await status()).lastSuccessfulRefresh, null);
    assert.equal((await notices()).length, 0);
    await pg.exec("DROP TRIGGER fixture_fail ON handrail_ai_events");
    await feedback.refresh(signal);
    assert.equal((await status()).state, "following");
    assert.ok((await status()).lastSuccessfulRefresh);
    await due();
    await feedback.refresh(signal);
    assert.equal((await notices()).length, 1);
    assert.equal(
      (await pg.query("SELECT payload FROM handrail_ai_documents WHERE kind='activity'")).rows[0].payload
        .unread,
      true,
    );
    assert.match((await notices())[0].payload.payload.content[0].text, /Which view\?\nOrder\nInvoice/);
    assert.equal(starts, 2, "recovery used only reads");
    await call("submit", input);
    assert.equal(posted, 1);
    assert.doesNotMatch((await notices())[0].payload.payload.content[0].text, /What it does today/);
    question.current_behavior = "Both views currently show open orders.";
    await due();
    await feedback.refresh(signal);
    assert.equal((await notices()).length, 2, "only current behavior changed");
    assert.match((await notices())[1].payload.payload.content[0].text,
      /What it does today\nBoth views currently show open orders\.\nNeeds your input\nWhich view\?\nOrder\nInvoice/);
    open = { ...question, information_request_id: randomUUID() };
    await due();
    await feedback.refresh(signal);
    assert.equal((await notices()).length, 3);
    const answer = {
      request_id: report,
      information_request_id: question.information_request_id,
      option: "Order",
      answer: "The first one",
    };
    await assert.rejects(call("answer", answer));
    assert.equal(saved, undefined);
    open = question;
    const receipt = await call("answer", answer);
    assert.equal(receipt.answered, true);
    assert.equal(receipt.resumption, "needs_recovery");
    assert.equal(
      kind === "bug" ? receipt.analysis_resumed : receipt.assessment_status,
      kind === "bug" ? false : "blocked",
    );
    assert.equal((await call("answer", answer)).replayed, true);
    await assert.rejects(call("answer", { ...answer, option: "Invoice" }));
    for (const content of [{ option: "Invoice" }, { answer: "Written answer only" }]) {
      intentVersion++;
      question.information_request_id = randomUUID();
      open = question;
      saved = undefined;
      const next = await call("answer", {
        request_id: report,
        information_request_id: open.information_request_id,
        ...content,
      });
      assert.equal(next.answered, true);
    }
    observationStatus = 503;
    await due();
    await feedback.refresh(signal);
    assert.equal((await status()).state, "unavailable");
    observationStatus = 200;
    await due();
    await feedback.refresh(signal);
    assert.equal((await status()).state, "following");
    await pg.query(
      "UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{grant,expires_at}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE kind='feedback_watch'",
    );
    const count = reads;
    await due();
    await feedback.refresh(signal);
    assert.equal(reads, count);
    assert.equal((await status()).state, "expired");
    await pg.query(
      "UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{grant,expires_at}',to_jsonb($1::text)) WHERE kind='feedback_watch'",
      [grant.expires_at],
    );
    if (kind === "bug") {
      observationStatus = 403;
      await due();
      await feedback.refresh(signal);
      assert.equal((await status()).state, "revoked");
    }
    await call("stop_follow_up", { request_id: report });
    const stopped = reads;
    await due();
    await feedback.refresh(signal);
    assert.equal(reads, stopped);
    assert.equal((await status()).state, "stopped");
    const nextVersion = intentVersion;
    intentVersion = 1;
    await assert.rejects(call("follow_up", follow)); // delayed retry of the stopped intent
    intentVersion = nextVersion;
    const oldId = grant.id;
    intentVersion++;
    observationStatus = 200;
    await call("follow_up", follow);
    assert.notEqual(grant.id, oldId);
    authorizedAtCommit = false;
    const before = (await notices()).length;
    await feedback.refresh(signal);
    assert.equal((await status()).state, "revoked");
    assert.equal((await notices()).length, before);
    authorizedAtCommit = true;
    // An old acknowledgement may arrive after stop AND renewal. Only the
    // exact renewed grant's delegated read can promote its pending record.
    let accepted, release;
    const acceptedRemotely = new Promise(resolve => { accepted = resolve; });
    const responseGate = new Promise(resolve => { release = resolve; });
    delayAck = () => { accepted(); return responseGate; };
    intentVersion++;
    const delayedStart = call("follow_up", follow);
    try {
      await acceptedRemotely;
      const delayedId = grant.id;
      await call("stop_follow_up", { request_id: report });
      intentVersion++;
      loseAck = true;
      await assert.rejects(call("follow_up", follow));
      assert.notEqual(grant.id, delayedId);
    } finally {
      release();
    }
    await assert.rejects(delayedStart, /superseded/);
    assert.equal((await status()).state, "pending");
    await feedback.refresh(signal);
    assert.equal((await status()).state, "following");

    // Legacy BBD/Spartan grants carry the literal local conversation ID.
    grant = { ...grant, id: randomUUID(), binding: { ...grant.binding, conversation_id: "legacy" } };
    await feedback.adoptLegacyGrant(context, "legacy", grant, signal);
    await feedback.adoptLegacyGrant(context, "legacy", grant, signal);
    await assert.rejects(feedback.adoptLegacyGrant(context, "elsewhere", grant, signal));
    await assert.rejects(
      feedback.adoptLegacyGrant({ ...context, tenantId: "other" }, "legacy", grant, signal),
    );
    assert.doesNotMatch(
      JSON.stringify((await pg.query("SELECT payload FROM handrail_ai_documents")).rows),
      /private-token|private-session/,
    );
  });

test("assistant recovery starts and joins optional feedback on shutdown", async () => {
  const { createHandrailAssistant, openaiResponses } =
    await import("handrail-agent-sdk/assistant/server/assistant");
  const pg = new PGlite();
  const adapt = (db) => ({
    query: async (q, v) => {
      const r = await db.query(q, v);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
    transaction: (fn) => fn(adapt(db)),
  });
  const persistence = postgresFromClient({
    ...adapt(pg),
    transaction: (fn) => pg.transaction((tx) => fn(adapt(tx))),
  });
  let started,
    joined = false;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  try {
    await persistence.persistence.migrate();
    const assistant = await createHandrailAssistant({
      id: "startup",
      persistence,
      authorize: () => {
        throw Error("unused");
      },
      attachmentCleanup: false,
      automaticTitles: false,
      provider: openaiResponses({
        model: "fixture",
        request: async () => {
          throw Error("offline");
        },
      }),
      feedback: {
        refresh: async (signal) => {
          started();
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          joined = true;
        },
      },
    });
    const keepAlive = setTimeout(() => {}, 5000);
    try {
      await ready;
    } finally {
      clearTimeout(keepAlive);
    }
    await assistant.stopBackgroundWorkers();
    assert.equal(joined, true);
  } finally {
    await pg.close();
  }
});
