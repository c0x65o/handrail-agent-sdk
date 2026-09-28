CREATE TABLE "agent_reference"."vault_entry_sessions" (
	"session_ref" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"job_revision" bigint NOT NULL,
	"revision" bigint NOT NULL,
	"state" text NOT NULL,
	"binding" jsonb NOT NULL,
	"authority" jsonb NOT NULL,
	"completion" jsonb,
	"receipt" jsonb,
	CONSTRAINT "vault_entry_job_revision" UNIQUE("job_id","job_revision"),
	CONSTRAINT "vault_entry_revision" CHECK ("agent_reference"."vault_entry_sessions"."revision" between 1 and 9007199254740991),
	CONSTRAINT "vault_entry_state" CHECK ("agent_reference"."vault_entry_sessions"."state" in ('open', 'captured', 'delivered', 'withdrawn', 'expired')),
	CONSTRAINT "vault_entry_completion" CHECK (("agent_reference"."vault_entry_sessions"."state" != 'open' or "agent_reference"."vault_entry_sessions"."completion" is null)
      and ("agent_reference"."vault_entry_sessions"."state" not in ('captured', 'delivered') or "agent_reference"."vault_entry_sessions"."completion" is not null)
      and ("agent_reference"."vault_entry_sessions"."state" != 'delivered' or "agent_reference"."vault_entry_sessions"."receipt" is not null))
);
--> statement-breakpoint
ALTER TABLE "agent_reference"."vault_entry_sessions" ADD CONSTRAINT "vault_entry_sessions_job_id_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "agent_reference"."jobs"("job_id") ON DELETE no action ON UPDATE no action;
