CREATE TABLE "agent_reference"."agent_run_states" (
	"job_id" text PRIMARY KEY NOT NULL,
	"version" bigint NOT NULL,
	"grant_revision" bigint NOT NULL,
	"key_ref" text NOT NULL,
	"envelope" jsonb NOT NULL,
	CONSTRAINT "agent_run_states_version" CHECK ("agent_reference"."agent_run_states"."version" between 1 and 9007199254740991),
	CONSTRAINT "agent_run_states_grant_revision" CHECK ("agent_reference"."agent_run_states"."grant_revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "agent_reference"."agent_run_states" ADD CONSTRAINT "agent_run_states_job_id_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "agent_reference"."jobs"("job_id") ON DELETE no action ON UPDATE no action;