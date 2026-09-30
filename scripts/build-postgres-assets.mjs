// Part of ordinary prepare/build: preserve canonical SQL bytes, without shipping
// Drizzle generator snapshots or unpublished reference implementation modules.
import { copyFile, mkdir, readdir } from 'node:fs/promises';
const source = new URL('../src/server/postgres/migrations/', import.meta.url);
const target = new URL('../dist/server/postgres/migrations/', import.meta.url);
await mkdir(new URL('meta/', target), { recursive: true });
for (const file of await readdir(source)) if (file.endsWith('.sql'))
  await copyFile(new URL(file, source), new URL(file, target));
await copyFile(new URL('meta/_journal.json', source), new URL('meta/_journal.json', target));
