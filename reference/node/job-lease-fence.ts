import { sameLeaseValue, validJobFence, validLeaseAuthority } from '../../src/server/job-lease.js';
import type { JobAppendFence, JobLeaseContext, JobLeaseFence } from '../../src/server/job-lease.js';
import { journalTables } from './db/schema.js';

type Head = ReturnType<typeof journalTables>['jobs']['$inferSelect'];
export function leaseNow(context: JobLeaseContext): number {
  const now = context.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error();
  return now;
}
export function leaseExpiry(now: number, ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(now + ttlMs)) throw new Error();
  return now + ttlMs;
}
/** Detach data synchronously; the clock is injected trusted code, never wire data. */
export function copyAppendFence(context: JobAppendFence): JobAppendFence {
  if (!validJobFence(context.fence) || !validLeaseAuthority(context.authority, context.fence.identity)) throw new Error();
  return { fence: JSON.parse(JSON.stringify(context.fence)), authority: JSON.parse(JSON.stringify(context.authority)), now: context.now };
}
export function matchesJobFence(head: Head, context: JobAppendFence): boolean {
  const { fence, authority } = context;
  return sameLeaseValue(head.identity, fence.identity) && sameLeaseValue(authority.host, head.identity.host)
    && head.leaseOwner === fence.ownerToken && head.leaseEpoch === fence.epoch
    && head.leaseGrantRevision === fence.grantRevision && head.leaseGrantRevision === authority.grantRevision
    && head.cancellationEpoch <= fence.cancellationRevision
    && head.leaseCancellationRevision === fence.cancellationRevision && head.leaseCancellationRevision === authority.cancellationRevision
    && head.leaseExpiresAt !== null && head.leaseExpiresAt > leaseNow(context);
}
export function fenceFromHead(head: Head): JobLeaseFence {
  return { identity: head.identity, host: head.identity.host, ownerToken: head.leaseOwner!, epoch: head.leaseEpoch,
    expiresAt: head.leaseExpiresAt!, grantRevision: head.leaseGrantRevision!, cancellationRevision: head.leaseCancellationRevision! };
}
export const releasedLease = { leaseOwner: null, leaseExpiresAt: null, leaseGrantRevision: null, leaseCancellationRevision: null };
