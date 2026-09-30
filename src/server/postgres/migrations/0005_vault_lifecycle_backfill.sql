-- One-time upgrade of existing immutable v1 envelopes. Never run as recovery:
-- the stock migration ledger must be retained with the authoritative states.
INSERT INTO "agent_reference"."vault_states"
  (item_id, scope, revision, generation, status, active_nonce)
SELECT item_id, scope, revision, 1, 'active', nonce
FROM "agent_reference"."vault_items";
