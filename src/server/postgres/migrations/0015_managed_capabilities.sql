CREATE TABLE "agent_reference"."managed_capability_records" (
  "scope" text NOT NULL,
  "id" text NOT NULL,
  "version" integer NOT NULL CHECK ("version" > 0),
  "key_ref" text NOT NULL,
  "envelope" jsonb NOT NULL,
  PRIMARY KEY ("scope", "id")
);
