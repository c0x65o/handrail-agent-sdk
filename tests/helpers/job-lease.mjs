import assert from 'node:assert/strict';
import { createJobLease } from '../../.reference-build/src/server/job-lease.js';
import { createJobLeaseStore } from '../../.reference-build/reference/node/job-lease.js';

// Fixed host policy for journal-only regressions. Real PostgreSQL owns every
// claim/fence; this is only the explicitly injected host authority/clock edge.
export function fixtureLeaseHost(identity) {
  let token = 0;
  return { now: () => 1000, newOwnerToken: () => `fixture-owner-${++token}`,
    withAuthority: async (_identity, _operation, run) => run({ host: identity.host, grantRevision: 1, cancellationRevision: 0 }) };
}
export function leasedJournals(first, second, tables, rawFirst, rawSecond) {
  let ready;
  let access;
  function wrap(raw, client) {
    return { load: identity => raw.load(identity), async append(event) {
      if (event.kind === 'submitted') {
        const result = await raw.append(event);
        if (result.ok) {
          ready ??= (async () => {
            const identity = result.value.event.snapshot.identity;
            const host = fixtureLeaseHost(identity);
            const claim = await createJobLease(host, createJobLeaseStore(client.database(), tables)).claim(identity, 100000);
            assert.equal(claim.ok, true, claim.code); assert.ok(claim.value);
            access = { fence: claim.value, authority: { host: identity.host, grantRevision: 1, cancellationRevision: 0 }, now: host.now };
          })();
          await ready;
        }
        return result;
      }
      return raw.append(event, access);
    } };
  }
  return [wrap(rawFirst, first), wrap(rawSecond, second)];
}
