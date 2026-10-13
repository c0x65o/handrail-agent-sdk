import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import type { Turn } from 'openai/resources/beta/agents/sessions/turns/turns';
import type { SessionArtifact } from 'openai/resources/beta/agents/sessions/artifacts';
import type { HostedSessionBinding } from './hosted-session.js';

/** Download completed-turn outputs into the application's existing attachment
 * custody before publishing a result or deleting a session. This also recovers
 * artifacts when the final live screenshot event was lost. No model-supplied
 * URL or local path chooses the source. The sink must upsert by original ID. */
export async function retainHostedArtifacts<T>(client: OpenAI, ports: {
  session: HostedSessionBinding;
  turn: Turn;
  signal: AbortSignal;
  maxBytes: number;
  authorize(): Promise<void>;
  retain(artifact: { metadata: SessionArtifact; data: Uint8Array; sha256: string; contentType: string | null }): Promise<T>;
}): Promise<T[]> {
  const { session, turn, signal, maxBytes } = ports;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw Error('HOSTED_ARTIFACT_CAPACITY_INVALID');
  if (!session.sessionId || turn.session_id !== session.sessionId || turn.subagent_id !== null
    || !['completed', 'cancelled', 'failed'].includes(turn.status)) throw Error('HOSTED_ARTIFACT_TURN_INVALID');
  await ports.authorize(); signal.throwIfAborted();
  const options = { signal, maxRetries: 0 };
  const original = await client.beta.agents.sessions.retrieve(session.sessionId, options);
  if (original.metadata.handrail_scope !== session.scopeDigest || original.metadata.handrail_creation !== session.creationKey
    || original.metadata.handrail_configuration !== session.configurationDigest || original.environment.type !== 'openai_hosted')
    throw Error('HOSTED_ARTIFACT_SCOPE_CONFLICT');
  const artifacts = client.beta.agents.sessions.artifacts;
  const results: T[] = [];
  for await (const metadata of artifacts.list(session.sessionId, { limit: 100 }, options)) {
    if (metadata.session_id !== session.sessionId) throw Error('HOSTED_ARTIFACT_SCOPE_CONFLICT');
    if (metadata.turn_id !== turn.id) continue;
    if (metadata.environment_id !== original.environment.id) throw Error('HOSTED_ARTIFACT_SCOPE_CONFLICT');
    if (!Number.isSafeInteger(metadata.size_bytes) || metadata.size_bytes < 1 || metadata.size_bytes > maxBytes)
      throw Error('HOSTED_ARTIFACT_CAPACITY_EXCEEDED');
    await ports.authorize(); signal.throwIfAborted();
    const response = await artifacts.content(metadata.id, { session_id: session.sessionId }, options);
    if (!response.ok || !response.body) throw Error('HOSTED_ARTIFACT_UNAVAILABLE');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      while (true) {
        const next = await reader.read(); signal.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > metadata.size_bytes || size > maxBytes) throw Error('HOSTED_ARTIFACT_SIZE_CHANGED');
        chunks.push(next.value);
      }
    } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (size !== metadata.size_bytes) throw Error('HOSTED_ARTIFACT_SIZE_CHANGED');
    const data = Buffer.concat(chunks), sha256 = createHash('sha256').update(data).digest('hex');
    await ports.authorize(); signal.throwIfAborted();
    results.push(await ports.retain({ metadata, data, sha256, contentType: response.headers.get('content-type') }));
  }
  return results;
}
