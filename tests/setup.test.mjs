import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPostgresAgentApplication } from 'handrail-agent-sdk/server/setup';

const keys = { current: async () => { throw Error('unexpected key access'); }, resolve: async () => { throw Error('unexpected key access'); } };
test('setup construction is inert and validates the agent namespace', () => {
  const pool = { connect: () => { throw Error('unexpected connection'); }, query: () => { throw Error('unexpected query'); } };
  const setup = createPostgresAgentApplication({pool, agentSchema: 'agent_test', keys});
  assert.equal(setup.assistance, null);
  assert.equal(typeof setup.migrate, 'function');
  assert.throws(() => createPostgresAgentApplication({pool, agentSchema: 'bad;schema', keys}));
});

test('repeatable setup preserves conversation history, approvals and durable usage across restart', {
  skip: process.env.HANDRAIL_TEST_POSTGRES_DISPOSABLE !== '1' || !process.env.HANDRAIL_TEST_POSTGRES_URL,
}, async () => {
  const schema = `setup_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Pool({connectionString:process.env.HANDRAIL_TEST_POSTGRES_URL, options:`-c search_path=${schema},pg_catalog`, max:2});
  try {
    const options = {pool, agentSchema:schema, keys, assistance:true};
    const first = createPostgresAgentApplication(options);
    const a = first.migrate();
    assert.equal(first.migrate(), a, 'same-instance bootstrap is coalesced');
    await a;
    const persistence = first.assistant.persistence;
    await persistence.writeCheckpoint('tenant', 'conversation', null, {messages:[{role:'user',content:'existing history'}]});
    await persistence.writeApprovalProposal('tenant', 'conversation', 'proposal', null, {state:'pending'});
    await persistence.compareAndSetDocument({tenantId:'tenant',kind:'usage_outbox',scopeId:'usage',recordId:'stable-receipt',expectedVersion:null,value:{state:'pending',receipt_id:'stable-receipt'}});
    const ledger = (await pool.query(`SELECT hash FROM "${schema}".journal_migrations ORDER BY id`)).rows;
    assert.ok(ledger.length > 0);
    await createPostgresAgentApplication(options).migrate();
    assert.deepEqual((await pool.query(`SELECT hash FROM "${schema}".journal_migrations ORDER BY id`)).rows, ledger);
    assert.deepEqual((await persistence.readCheckpoint('tenant','conversation')).value.messages, [{role:'user',content:'existing history'}]);
    assert.equal((await persistence.readApprovalProposal('tenant','conversation','proposal')).value.state, 'pending');
    assert.equal((await persistence.getDocument('tenant','usage_outbox','usage','stable-receipt')).value.receipt_id, 'stable-receipt');
    assert.equal(await persistence.readCheckpoint('other-tenant','conversation'), null);
  } finally { await pool.end(); }
  // The owning runner destroys its whole disposable cluster. No ambient database cleanup.
});
