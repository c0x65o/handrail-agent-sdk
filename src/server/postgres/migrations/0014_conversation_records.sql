CREATE TABLE "agent_reference"."conversation_records" (
  scope text NOT NULL,
  collection text NOT NULL,
  id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  ordinal bigint NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
  payload jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (scope, collection, id)
);
--> statement-breakpoint
CREATE INDEX conversation_records_page ON "agent_reference"."conversation_records" (scope, collection, ordinal, id);
--> statement-breakpoint
CREATE INDEX conversation_records_active ON "agent_reference"."conversation_records" (scope, collection, ordinal, id) WHERE active;
