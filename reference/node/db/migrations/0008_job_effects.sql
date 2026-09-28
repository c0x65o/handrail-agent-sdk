CREATE TABLE "agent_reference"."job_effects" (
  "job_id" text NOT NULL REFERENCES "agent_reference"."jobs"("job_id"),
  "effect_ref" text NOT NULL,
  "provider_ref" text NOT NULL,
  "idempotency_ref" text NOT NULL,
  "request" jsonb NOT NULL,
  "admission_authority" jsonb NOT NULL,
  "authority" jsonb NOT NULL,
  "reconciliation" jsonb,
  "observation" jsonb NOT NULL,
  "resolved_revision" bigint,
  PRIMARY KEY ("job_id", "effect_ref"),
  CONSTRAINT "effects_provider_idempotency_unique" UNIQUE ("provider_ref", "idempotency_ref"),
  CONSTRAINT "effects_observation_shape" CHECK (
    ("observation"->>'outcome' = 'unknown' AND "resolved_revision" IS NULL)
    OR ("observation"->>'outcome' = 'verified' AND "observation"->>'receiptRef' IS NOT NULL)
  )
);
