import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './reference/node/db/schema.ts',
  out: './reference/node/db/migrations',
});
