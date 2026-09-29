import type { VaultOperation, VaultRequestDestination } from '../contracts/vault.js';
import { validateVaultOperationSchema } from '../contracts/vault.js';
import type { EffectRequest } from './effects.js';
import { sameLeaseValue } from './job-lease.js';
import type { TrustedVaultExecutor } from './vault-use.js';

export type VaultTokenRequest = Extract<VaultOperation, { operation: 'server_request'; item: { metadata: { kind: 'token' } } }>;
/** All fields are trusted server registration, never tool arguments. */
export interface VaultRequestBinding {
  readonly operationRef: string;
  readonly recipeRevision: number;
  readonly destination: VaultRequestDestination;
  /** Fixed nonsecret payload. No model-controlled template or signing callback. */
  readonly body?: string;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  /** Separate from the public HTTPS destination; only disposable synthetic tests. */
  readonly fixture?: { readonly kind: 'disposable_loopback'; readonly endpoint: string; readonly environmentRef: string };
}
export interface VaultRequestRecipe<PrivateValue> extends VaultRequestBinding {
  /** Hash BOTH the complete public operation and supplied immutable recipe binding.
   * Use the host's existing effect/idempotency namespace; never hash the token. */
  bind(request: VaultTokenRequest, binding: VaultRequestBinding): EffectRequest;
  token(value: PrivateValue): string;
  /** Private bounded response verification. Only literal true is accepted; no
   * returned provider fields, headers, URLs or errors can become observations. */
  verify(body: Uint8Array, request: VaultTokenRequest): boolean;
  /** Existing read-only domain reconciler; no token. not_applied must exclude
   * late in-flight effects. Unknown never authorizes another network attempt. */
  reconcile(request: VaultTokenRequest, signal: AbortSignal): Promise<'verified' | 'not_applied' | 'unknown'>;
}
export interface VaultHttpResponse {
  readonly status: number;
  /** Decoded bytes. Client must bound headers and decompression before buffering. */
  readonly body: AsyncIterable<Uint8Array>;
}
export interface VaultHttpConnection {
  /** Actual authenticated URL and socket peer, established before send. */
  readonly endpoint: string;
  readonly address: string;
  readonly port: number;
  send(request: {
    readonly method: VaultRequestDestination['method'];
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly redirects: 'deny';
    readonly retries: 0;
    readonly maxRequestBytes: number;
    readonly maxHeaderBytes: number;
    readonly maxResponseBytes: number;
    /** Pass to the existing provider client's idempotency handling. */
    readonly effect: EffectRequest;
  }, signal: AbortSignal): Promise<VaultHttpResponse>;
}
/** Adapt the host's existing approved HTTP/provider client. No global fetch or
 * second provider wrapper. No credentials, cookies or telemetry during resolve/
 * connect. Pin the supplied address (no second DNS lookup, proxy, reconnect or
 * alternate address); authenticate HTTPS certificate AND original hostname.
 * Enforce wire request/header limits and decoded response limits. Never
 * redirect/retry, log private traffic, or retain response bytes/errors.
 * Close the connection/stream on callback exit, rejection or abort. */
export interface VaultHttpClient {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
  withConnection<T>(endpoint: string, address: string, signal: AbortSignal,
    run: (connection: VaultHttpConnection) => Promise<T>): Promise<T>;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const fail = (): never => { throw new Error('INVALID_VAULT_REQUEST'); };
const ref = (v: string) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
function endpoint(value: string, fixture: boolean): URL {
  const u = new URL(value);
  if (value !== u.href || value.length > 2048 || u.username || u.password || value.includes('?') || value.includes('#')
    || (fixture ? u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port : u.protocol !== 'https:')) fail();
  return u;
}
/** Deliberately conservative: globally routable canonical IPv4 only. IPv6,
 * mapped/tunnel forms and noncanonical representations fail closed in v1. */
function publicAddress(value: string): boolean {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  if ([a, b, c, d].some(n => n > 255)) return false;
  return !(value === '168.63.129.16' || a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

/** Register with createVaultUse. Its custody/grant/lease fences, deadline and
 * durable effect reconciliation remain the sole execution authority. */
export function createVaultRequestExecutor<PrivateValue>(recipe: VaultRequestRecipe<PrivateValue>,
  client: VaultHttpClient): TrustedVaultExecutor<PrivateValue> {
  let binding: VaultRequestBinding, target: URL, payload: Uint8Array;
  const bind = recipe.bind.bind(recipe), token = recipe.token.bind(recipe), verify = recipe.verify.bind(recipe),
    reconcile = recipe.reconcile.bind(recipe);
  const resolve = client.resolve.bind(client), connect = client.withConnection.bind(client);
  try {
    binding = copy({ operationRef: recipe.operationRef, recipeRevision: recipe.recipeRevision, destination: recipe.destination,
      ...(recipe.body === undefined ? {} : { body: recipe.body }), maxRequestBytes: recipe.maxRequestBytes,
      maxResponseBytes: recipe.maxResponseBytes, ...(recipe.fixture === undefined ? {} : { fixture: recipe.fixture }) });
    if (!ref(binding.operationRef) || !Number.isSafeInteger(binding.recipeRevision) || binding.recipeRevision < 1
      || ![binding.maxRequestBytes, binding.maxResponseBytes].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1_048_576)
      || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(binding.destination.method)
      || binding.destination.redirects !== 'deny' || !ref(binding.destination.resourceRef)
      || (binding.body !== undefined && typeof binding.body !== 'string')) fail();
    target = endpoint(binding.destination.endpoint, false);
    if (binding.fixture) {
      if (binding.fixture.kind !== 'disposable_loopback' || !ref(binding.fixture.environmentRef)) fail();
      target = endpoint(binding.fixture.endpoint, true);
    }
    payload = new TextEncoder().encode(binding.body ?? '');
    if (payload.byteLength > binding.maxRequestBytes || (binding.destination.method === 'GET' && payload.byteLength)) fail();
  } catch { return fail(); }
  function checked(request: VaultOperation): VaultTokenRequest {
    if (!validateVaultOperationSchema(request).ok || request.operation !== 'server_request' || request.item.metadata.kind !== 'token'
      || request.effect.operationRef !== binding.operationRef || !sameLeaseValue(request.destination, binding.destination)
      || (binding.fixture && request.identity.host.environmentRef !== binding.fixture.environmentRef)) fail();
    return copy(request) as VaultTokenRequest;
  }
  return {
    operationRef: binding.operationRef,
    bind: request => bind(checked(request), copy(binding)),
    async dispatch(request, value, signal, isCurrent) {
      try {
        const r = checked(request);
        if (signal.aborted || !isCurrent()) return 'unknown';
        const addresses = await resolve(target.hostname, signal);
        const allowed = (a: string) => binding.fixture ? a === '127.0.0.1' : publicAddress(a);
        if (signal.aborted || !isCurrent() || !Array.isArray(addresses) || !addresses.length || addresses.length > 32 || !addresses.every(allowed)) return 'unknown';
        const address = addresses[0];
        let entered = false, outcome: 'verified' | 'unknown' = 'unknown';
        await connect(target.href, address, signal, async connection => {
          // Even a repeated callback may not dispatch the same effect twice.
          if (entered) return;
          entered = true;
          if (signal.aborted || !isCurrent() || connection.endpoint !== target.href || connection.address !== address
            || connection.port !== Number(target.port || 443) || !allowed(connection.address)) return;
          const secret = token(value);
          // Bearer only: deny header injection and bound total request bytes.
          if (typeof secret !== 'string' || secret.length + payload.byteLength + target.href.length + 256 > binding.maxRequestBytes
            || !/^[A-Za-z0-9._~+\/-]+=*$/.test(secret) || signal.aborted || !isCurrent()) return;
          const response = await connection.send({ method: binding.destination.method,
            headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
            body: payload.slice(), redirects: 'deny', retries: 0, maxRequestBytes: binding.maxRequestBytes,
            maxHeaderBytes: 4096, maxResponseBytes: binding.maxResponseBytes,
            effect: bind(r, copy(binding)) }, signal);
          if (signal.aborted || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) return;
          const body = new Uint8Array(binding.maxResponseBytes); let size = 0;
          for await (const chunk of response.body) {
            if (signal.aborted || !(chunk instanceof Uint8Array) || size + chunk.byteLength > binding.maxResponseBytes) return;
            body.set(chunk, size); size += chunk.byteLength;
          }
          if (signal.aborted) return;
          if (verify(body.subarray(0, size), r) === true && !signal.aborted && isCurrent()) outcome = 'verified';
        });
        // Ignore all values returned by the client itself.
        return signal.aborted || !isCurrent() ? 'unknown' : outcome;
      } catch { return 'unknown'; }
    },
    async reconcile(request, signal) {
      try {
        const result = await reconcile(checked(request), signal);
        return !signal.aborted && ['verified', 'not_applied'].includes(result) ? result : 'unknown';
      } catch { return 'unknown'; }
    },
  };
}
