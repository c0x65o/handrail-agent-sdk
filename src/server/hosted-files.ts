import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import type { HostedSessionBinding } from './hosted-session.js';

export interface HostedFileReceipt {
  sessionId: string;
  environmentId: string;
  sourceDigest: string;
  path: string;
  sizeBytes: number;
  attempted: boolean;
  copied: boolean;
}
export type HostedFileSource = { data: Uint8Array; filename: string } | { fileId: string; filename: string };
/** The caller authorizes the source and stores this receipt in its existing
 * encrypted job/conversation record. Destination names bind bytes or file ID to
 * the scoped provider session. Do not send arbitrary model-provided file IDs. */
export async function attachHostedFile(client: OpenAI, ports: {
  session: HostedSessionBinding;
  source: HostedFileSource;
  receipt?: HostedFileReceipt;
  signal: AbortSignal;
  authorize(): Promise<void>;
  save(receipt: HostedFileReceipt): Promise<void>;
}): Promise<HostedFileReceipt> {
  await ports.authorize();
  if (!ports.session.sessionId) throw Error('HOSTED_SESSION_REQUIRED');
  const options = { signal: ports.signal, maxRetries: 0 };
  const session = await client.beta.agents.sessions.retrieve(ports.session.sessionId, options);
  if (session.metadata.handrail_scope !== ports.session.scopeDigest || session.metadata.handrail_creation !== ports.session.creationKey
    || session.metadata.handrail_configuration !== ports.session.configurationDigest || session.environment.type !== 'openai_hosted') throw Error('HOSTED_FILE_SCOPE_CONFLICT');
  // A session can exist while its environment is provisioning. Waiting here is
  // read-only; do not record an upload intent until the destination is ready.
  while (true) {
    await ports.authorize();
    const environment = await client.beta.agents.environments.retrieve(session.environment.id, options);
    if (environment.id !== session.environment.id || environment.type !== 'openai_hosted') throw Error('HOSTED_FILE_SCOPE_CONFLICT');
    if (environment.status === 'connected' || environment.status === 'ready') break;
    if (environment.status !== 'pending') throw Error('HOSTED_ENVIRONMENT_NOT_CONNECTED');
    await delay(500, undefined, { signal: ports.signal });
  }
  const source = ports.source;
  const digest = createHash('sha256').update('fileId' in source ? `file:${source.fileId}` : source.data).digest('hex');
  const filename = source.filename.split(/[\\/]/).at(-1)!.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'attachment';
  const path = `/workspace/handrail-inputs/${digest}-${filename}`;
  const sizeBytes = 'data' in source ? source.data.byteLength : (await client.files.retrieve(source.fileId, options)).bytes;
  if (sizeBytes > ('data' in source ? 5 : 50) * 1024 * 1024) throw Error('HOSTED_FILE_SIZE_EXCEEDED');
  let receipt: HostedFileReceipt = ports.receipt ?? { sessionId: session.id, environmentId: session.environment.id,
    sourceDigest: digest, path, sizeBytes, attempted: false, copied: false };
  if (receipt.sessionId !== session.id || receipt.environmentId !== session.environment.id || receipt.sourceDigest !== digest
    || receipt.path !== path || receipt.sizeBytes !== sizeBytes) throw Error('HOSTED_FILE_RECEIPT_CONFLICT');
  // Reconcile the original destination after a lost response. Never overwrite a
  // file or blindly issue a second create after an ambiguous upload.
  const find = async () => {
    for await (const file of client.beta.agents.environments.files.list(receipt.environmentId, { path: '/workspace/handrail-inputs', limit: 100 }, options))
      if (file.path === receipt.path) {
        if (file.environment_id !== receipt.environmentId || file.size_bytes !== receipt.sizeBytes) throw Error('HOSTED_FILE_RECEIPT_CONFLICT');
        return true;
      }
    return false;
  };
  if (receipt.copied) {
    if (!await find()) throw Error('HOSTED_FILE_MISSING');
    return receipt;
  }
  if (receipt.attempted) {
    if (!await find()) throw Error('HOSTED_FILE_COPY_UNCERTAIN');
  } else {
    receipt = { ...receipt, attempted: true }; await ports.save(receipt);
    await ports.authorize();
    const file = await client.beta.agents.environments.files.create(receipt.environmentId,
      'data' in source ? { type: 'inline', path, data: Buffer.from(source.data).toString('base64') } : { type: 'file_id', path, file_id: source.fileId }, options);
    if (file.path !== path || file.size_bytes !== sizeBytes || file.environment_id !== receipt.environmentId) throw Error('HOSTED_FILE_RECEIPT_CONFLICT');
  }
  await ports.authorize();
  receipt = { ...receipt, copied: true }; await ports.save(receipt);
  return receipt;
}
