CREATE TABLE "agent_reference"."job_challenges" (
  "job_id" text PRIMARY KEY REFERENCES "agent_reference"."jobs"("job_id"),
  "requirement_ref" text NOT NULL,
  "requirement_revision" bigint NOT NULL CHECK ("requirement_revision" > 0),
  "job_revision" bigint NOT NULL CHECK ("job_revision" > 0),
  "expires_at" bigint NOT NULL CHECK ("expires_at" BETWEEN 0 AND 9007199254740991),
  "resolver_ref" text NOT NULL,
  "grant_revision" bigint NOT NULL CHECK ("grant_revision" > 0),
  "cancellation_revision" bigint NOT NULL CHECK ("cancellation_revision" >= 0),
  "consumed" integer NOT NULL DEFAULT 0 CHECK ("consumed" IN (0, 1))
);
CREATE TABLE "agent_reference"."job_answer_deliveries" (
  "job_id" text NOT NULL REFERENCES "agent_reference"."jobs"("job_id"),
  "delivery_key" text NOT NULL,
  "digest" text NOT NULL,
  "event_cursor" bigint NOT NULL CHECK ("event_cursor" > 0),
  PRIMARY KEY ("job_id", "delivery_key")
);
