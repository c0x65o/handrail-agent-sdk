CREATE TABLE "agent_reference"."browser_profile_snapshots" (
	"profile_ref" text PRIMARY KEY NOT NULL,
	"metadata" jsonb NOT NULL,
	"envelope_version" integer NOT NULL,
	"algorithm" text NOT NULL,
	"key_handle" text NOT NULL,
	"key_version" integer NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "browser_profile_key_nonce_unique" UNIQUE("key_handle","key_version","nonce")
);
--> statement-breakpoint
CREATE TABLE "agent_reference"."browser_profile_states" (
	"profile_ref" text PRIMARY KEY NOT NULL,
	"scope" jsonb NOT NULL,
	"revision" bigint NOT NULL,
	"authority_epoch" bigint NOT NULL,
	"status" text NOT NULL,
	"active_nonce" text,
	CONSTRAINT "browser_profile_revision" CHECK ("agent_reference"."browser_profile_states"."revision" between 1 and 9007199254740991),
	CONSTRAINT "browser_profile_epoch" CHECK ("agent_reference"."browser_profile_states"."authority_epoch" between 1 and 9007199254740991),
	CONSTRAINT "browser_profile_state" CHECK (("agent_reference"."browser_profile_states"."status" = 'active' and "agent_reference"."browser_profile_states"."active_nonce" is not null) or
      ("agent_reference"."browser_profile_states"."status" in ('revoked', 'deleted') and "agent_reference"."browser_profile_states"."active_nonce" is null))
);
