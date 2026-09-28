CREATE TABLE "agent_reference"."connection_receipts" (
	"receipt_ref" text PRIMARY KEY NOT NULL,
	"connection_ref" text NOT NULL,
	"credential_revision" bigint NOT NULL,
	"grant_revision" bigint NOT NULL,
	"evidence" jsonb NOT NULL,
	CONSTRAINT "connection_receipt_revisions" CHECK ("agent_reference"."connection_receipts"."credential_revision" between 1 and 9007199254740991 and "agent_reference"."connection_receipts"."grant_revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "agent_reference"."connection_revisions" (
	"connection_ref" text NOT NULL,
	"revision" bigint NOT NULL,
	"command" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "connection_revisions_connection_ref_revision_pk" PRIMARY KEY("connection_ref","revision"),
	CONSTRAINT "connection_revisions_positive" CHECK ("agent_reference"."connection_revisions"."revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "agent_reference"."connections" (
	"connection_ref" text PRIMARY KEY NOT NULL,
	"scope" jsonb NOT NULL,
	"provider_ref" text NOT NULL,
	"capability_digest" text NOT NULL,
	"recipe_version" text NOT NULL,
	"evidence_mode" text NOT NULL,
	"request" jsonb NOT NULL,
	"revision" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "connections_logical_identity" UNIQUE("scope","provider_ref","capability_digest","recipe_version","evidence_mode"),
	CONSTRAINT "connections_revision" CHECK ("agent_reference"."connections"."revision" between 1 and 9007199254740991),
	CONSTRAINT "connections_mode" CHECK ("agent_reference"."connections"."evidence_mode" in ('fixture', 'provider'))
);
--> statement-breakpoint
ALTER TABLE "agent_reference"."connection_receipts" ADD CONSTRAINT "connection_receipts_connection_ref_connections_connection_ref_fk" FOREIGN KEY ("connection_ref") REFERENCES "agent_reference"."connections"("connection_ref") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reference"."connection_revisions" ADD CONSTRAINT "connection_revisions_connection_ref_connections_connection_ref_fk" FOREIGN KEY ("connection_ref") REFERENCES "agent_reference"."connections"("connection_ref") ON DELETE no action ON UPDATE no action;