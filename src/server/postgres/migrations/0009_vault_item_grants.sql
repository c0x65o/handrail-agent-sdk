CREATE TABLE "agent_reference"."vault_item_grants" (
  "grant_ref" text PRIMARY KEY NOT NULL,
  "item_id" text NOT NULL,
  "revision" bigint NOT NULL CHECK ("revision" between 1 and 9007199254740991),
  "grant" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_reference"."vault_access" (
  "receipt_ref" text PRIMARY KEY NOT NULL,
  "item_id" text NOT NULL,
  "at" bigint NOT NULL,
  "phase" text NOT NULL CHECK ("phase" in ('admit', 'dispatch')),
  "outcome" text NOT NULL CHECK ("outcome" in ('authorized', 'denied', 'expired', 'revoked', 'stale_grant', 'unknown', 'verified'))
);
--> statement-breakpoint
CREATE INDEX "vault_access_item_time" ON "agent_reference"."vault_access" ("item_id", "at", "receipt_ref");
