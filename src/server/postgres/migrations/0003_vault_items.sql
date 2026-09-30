CREATE TABLE "agent_reference"."vault_items" (
	"item_id" text PRIMARY KEY NOT NULL,
	"revision" bigint NOT NULL,
	"scope" jsonb NOT NULL,
	"item" jsonb NOT NULL,
	"envelope_version" integer NOT NULL,
	"algorithm" text NOT NULL,
	"key_handle" text NOT NULL,
	"key_version" integer NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "vault_key_nonce_unique" UNIQUE("key_handle","key_version","nonce"),
	CONSTRAINT "vault_safe_revision" CHECK ("agent_reference"."vault_items"."revision" between 1 and 9007199254740991)
);
