ALTER TABLE "agent_reference"."jobs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "agent_reference"."jobs" ADD COLUMN "lease_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_reference"."jobs" ADD COLUMN "lease_expires_at" bigint;--> statement-breakpoint
ALTER TABLE "agent_reference"."jobs" ADD COLUMN "lease_grant_revision" bigint;--> statement-breakpoint
ALTER TABLE "agent_reference"."jobs" ADD COLUMN "lease_cancellation_revision" bigint;--> statement-breakpoint
ALTER TABLE "agent_reference"."jobs" ADD CONSTRAINT "jobs_safe_lease_epoch" CHECK ("agent_reference"."jobs"."lease_epoch" between 0 and 9007199254740991);--> statement-breakpoint
ALTER TABLE "agent_reference"."jobs" ADD CONSTRAINT "jobs_lease_shape" CHECK ((
      "agent_reference"."jobs"."lease_owner" is null and "agent_reference"."jobs"."lease_expires_at" is null and "agent_reference"."jobs"."lease_grant_revision" is null and "agent_reference"."jobs"."lease_cancellation_revision" is null
    ) or (
      "agent_reference"."jobs"."lease_owner" is not null and "agent_reference"."jobs"."lease_expires_at" is not null and "agent_reference"."jobs"."lease_grant_revision" is not null and "agent_reference"."jobs"."lease_cancellation_revision" is not null
      and "agent_reference"."jobs"."lease_owner" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and "agent_reference"."jobs"."lease_epoch" > 0
      and "agent_reference"."jobs"."lease_expires_at" between 0 and 9007199254740991
      and "agent_reference"."jobs"."lease_grant_revision" between 1 and 9007199254740991
      and "agent_reference"."jobs"."lease_cancellation_revision" between 0 and 9007199254740991
    ));