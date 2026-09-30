ALTER TABLE "agent_reference"."jobs" ADD COLUMN "cancellation_epoch" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "agent_reference"."jobs" ADD CONSTRAINT "jobs_safe_cancellation_epoch" CHECK ("cancellation_epoch" between 0 and 9007199254740991);
CREATE TABLE "agent_reference"."job_cancellation_evidence" (
  "job_id" text NOT NULL REFERENCES "agent_reference"."jobs"("job_id"),
  "effect_ref" text NOT NULL,
  "evidence_ref" text NOT NULL,
  "outcome" text NOT NULL,
  "actor_ref" text NOT NULL,
  CONSTRAINT "job_cancellation_evidence_pkey" PRIMARY KEY ("job_id", "effect_ref", "evidence_ref"),
  CONSTRAINT "cancellation_evidence_outcome" CHECK ("outcome" in ('unknown', 'verified', 'not_applied'))
);
