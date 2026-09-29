CREATE TABLE "agent_reference"."vault_preparations" (
	"rotation_id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"generation" bigint NOT NULL,
	"source_nonce" text NOT NULL,
	"envelope" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_reference"."vault_states" (
	"item_id" text PRIMARY KEY NOT NULL,
	"scope" jsonb NOT NULL,
	"revision" bigint NOT NULL,
	"generation" bigint NOT NULL,
	"status" text NOT NULL,
	"active_nonce" text,
	"last_rotation" text,
	CONSTRAINT "vault_state_generation" CHECK ("agent_reference"."vault_states"."generation" between 1 and 9007199254740991),
	CONSTRAINT "vault_state_shape" CHECK (("agent_reference"."vault_states"."status" = 'active' and "agent_reference"."vault_states"."active_nonce" is not null) or
      ("agent_reference"."vault_states"."status" in ('deleted', 'revoked') and "agent_reference"."vault_states"."active_nonce" is null and "agent_reference"."vault_states"."last_rotation" is null))
);
