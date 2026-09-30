CREATE TABLE "agent_reference"."job_checkpoints" (
	"job_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"revision" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "checkpoints_safe_revision" CHECK ("agent_reference"."job_checkpoints"."revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "agent_reference"."job_deliveries" (
	"job_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"attempt_ref" text NOT NULL,
	"delivery" jsonb NOT NULL,
	CONSTRAINT "job_deliveries_job_id_revision_attempt_ref_pk" PRIMARY KEY("job_id","revision","attempt_ref")
);
--> statement-breakpoint
CREATE TABLE "agent_reference"."job_events" (
	"job_id" text NOT NULL,
	"revision" bigint NOT NULL,
	"event" jsonb NOT NULL,
	CONSTRAINT "job_events_job_id_revision_pk" PRIMARY KEY("job_id","revision"),
	CONSTRAINT "events_safe_revision" CHECK ("agent_reference"."job_events"."revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "agent_reference"."jobs" (
	"job_id" text PRIMARY KEY NOT NULL,
	"identity" jsonb NOT NULL,
	"revision" bigint NOT NULL,
	CONSTRAINT "jobs_safe_revision" CHECK ("agent_reference"."jobs"."revision" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "agent_reference"."job_checkpoints" ADD CONSTRAINT "job_checkpoints_job_id_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "agent_reference"."jobs"("job_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reference"."job_deliveries" ADD CONSTRAINT "job_deliveries_job_id_revision_job_events_job_id_revision_fk" FOREIGN KEY ("job_id","revision") REFERENCES "agent_reference"."job_events"("job_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reference"."job_events" ADD CONSTRAINT "job_events_job_id_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "agent_reference"."jobs"("job_id") ON DELETE no action ON UPDATE no action;