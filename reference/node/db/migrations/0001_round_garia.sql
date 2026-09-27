CREATE TABLE "agent_reference"."job_admissions" (
	"tenant_ref" text NOT NULL,
	"user_ref" text NOT NULL,
	"namespace_ref" text NOT NULL,
	"request_key" text NOT NULL,
	"digest" text NOT NULL,
	"job_id" text NOT NULL,
	CONSTRAINT "job_admissions_tenant_ref_user_ref_namespace_ref_request_key_pk" PRIMARY KEY("tenant_ref","user_ref","namespace_ref","request_key"),
	CONSTRAINT "admissions_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "agent_reference"."job_admissions" ADD CONSTRAINT "job_admissions_job_id_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "agent_reference"."jobs"("job_id") ON DELETE no action ON UPDATE no action;