import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import type { InitialItem, SessionConfig } from 'openai/resources/live/live';
import type { ConnectClientEvent, ConnectServerEvent } from 'openai/resources/live/sideband/sideband';

export const LIVE_MODEL = 'gpt-live-1';
export type LiveServerEvent = ConnectServerEvent;
export type LiveClientEvent = ConnectClientEvent;
export type LiveHistoryItem = InitialItem;

/** Contains only public diagnostics. Provider bodies, keys and prompts are never
 * copied into errors. A known remote identity remains in the host's call record. */
export class LiveTransportError extends Error {
  /** Server-only reconciliation data; never serialize as a public error body. */
  providerId: string | undefined;
  cleanup: 'requested' | 'unconfirmed' | undefined;
  constructor(readonly code: 'invalid_offer' | 'creation_failed' | 'invalid_answer' |
    'receipt_failed' | 'connection_failed' | 'connection_closed' | 'hangup_failed',
    readonly statusCode = 502) {
    super(`GPT-Live ${code.replaceAll('_', ' ')}.`);
  }
}

export interface LiveTransport {
  readonly providerId: string;
  readonly sdp: string;
  send(event: LiveClientEvent): void;
  /** Hangup requests termination; only session.closed confirms final usage. */
  hangup(): Promise<void>;
  /** Release only the sideband, after finalization or explicit incomplete close. */
  dispose(): void;
}

export interface LiveTransportInput {
  readonly sdp: string;
  readonly input: LiveHistoryItem[];
  readonly instructions: string;
  readonly voice?: NonNullable<NonNullable<SessionConfig['audio']>['output']>['voice'];
  readonly signal?: AbortSignal;
  readonly onEvent: (event: LiveServerEvent) => void;
  readonly onDisconnect: (message: string) => void;
  /** Persist the original provider identity before attaching any work receiver. */
  readonly onCreated: (providerId: string) => Promise<void>;
  readonly onTiming?: (timing: Record<string, number>) => void;
}

/** OpenAI owns HTTP serialization, authentication and sideband protocol. The
 * application owns admission and durable custody; there is no retry of creation
 * or automatic replay of sideband commands after a lost connection. */
export function createLiveTransportConnector(options: {
  client: OpenAI;
  timeoutMs?: number;
  monotonicNow?: () => number;
}) {
  const { client } = options;
  const timeoutMs = options.timeoutMs ?? 25_000;
  const clock = options.monotonicNow ?? (() => performance.now());
  const timing = (input: LiveTransportInput, key: string, start: number) => {
    try { input.onTiming?.({ [key]: Math.max(0, Math.round(clock() - start)) }); }
    catch { /* Diagnostics do not change the outcome. */ }
  };
  const hangup = async (providerId: string) => {
    try { await client.live.sessions.hangup(providerId, { maxRetries: 0, timeout: timeoutMs }); }
    catch { throw new LiveTransportError('hangup_failed'); }
  };
  const connect = async (input: LiveTransportInput): Promise<LiveTransport> => {
    if (typeof input.sdp !== 'string' || !input.sdp.startsWith('v=0') || Buffer.byteLength(input.sdp) > 65_536) {
      throw new LiveTransportError('invalid_offer', 400);
    }
    input.signal?.throwIfAborted();
    let created: Awaited<ReturnType<OpenAI['live']['create']>>;
    const started = clock();
    try {
      created = await client.live.create({
        session: { model: LIVE_MODEL, instructions: input.instructions, input: input.input,
          delegation: { type: 'client' }, audio: { output: { voice: input.voice ?? 'marin' } }, store: false,
          // Browser audio/captions stay native. Only the trusted server may
          // supply instructions, delegate work or publish a backend result.
          client: { data_channel: {
            allowed_client_events: ['session.close'],
            allowed_server_events: ['session.started', 'session.closed', 'session.usage.updated',
              'session.input_transcript.delta', 'session.output_transcript.delta', 'error'].map(type => ({ type })),
          } },
        }, transport: { type: 'webrtc', sdp: input.sdp },
      }, { maxRetries: 0, timeout: timeoutMs, ...(input.signal ? { signal: input.signal } : {}) });
    } catch { throw new LiveTransportError('creation_failed'); }
    timing(input, 'provider_session_create_duration_ms', started);
    const providerId = created?.session?.id;
    if (typeof providerId !== 'string' || !providerId || providerId.length > 256) throw new LiveTransportError('invalid_answer');
    let sideband: SidebandWS | undefined;
    let disposed = false;
    let failure: LiveTransportError | undefined;
    let disconnected = false;
    const disconnect = () => {
      if (disposed || disconnected) return;
      disconnected = true;
      input.onDisconnect('The voice connection to OpenAI closed. Saved conversation work remains available.');
    };
    try {
      try { await input.onCreated(providerId); }
      catch { throw new LiveTransportError('receipt_failed'); }
      if (created.transport?.type !== 'webrtc' || typeof created.transport.sdp !== 'string' ||
        !created.transport.sdp.startsWith('v=0') || Buffer.byteLength(created.transport.sdp) > 262_144) {
        throw new LiveTransportError('invalid_answer');
      }
      input.signal?.throwIfAborted();
      const controlStarted = clock();
      sideband = new SidebandWS(client, { session_id: providerId }, { handshakeTimeout: timeoutMs, reconnect: null });
      sideband.on('event', event => {
        if (disposed || ['session.input_audio.append', 'session.output_audio.delta'].includes(event.type)) return;
        try { input.onEvent(event); }
        catch { failure = new LiveTransportError('connection_failed'); disconnect(); }
      });
      sideband.on('error', () => { failure = new LiveTransportError('connection_failed'); disconnect(); });
      sideband.on('close', () => { failure ??= new LiveTransportError('connection_closed'); disconnect(); });
      const socket = sideband.socket;
      await new Promise<void>((resolve, reject) => {
        const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(input.signal ? [input.signal] : [])]);
        const finish = (error?: Error) => {
          socket.off('open', ready); socket.off('error', failed); socket.off('close', failed);
          signal.removeEventListener('abort', failed);
          if (error) reject(error); else resolve();
        };
        const ready = () => finish(failure);
        const failed = () => finish(new LiveTransportError('connection_failed'));
        socket.once('open', ready); socket.once('error', failed); socket.once('close', failed);
        signal.addEventListener('abort', failed, { once: true });
        if (signal.aborted) failed();
        else if (socket.readyState === 1) ready();
      });
      timing(input, 'provider_control_connect_duration_ms', controlStarted);
      const attached = sideband;
      return {
        providerId, sdp: created.transport.sdp,
        send(event) {
          if (disposed || disconnected || attached.socket.readyState !== 1) throw new LiveTransportError('connection_closed');
          attached.send({ event_id: randomUUID(), ...event });
        },
        hangup: () => hangup(providerId),
        dispose() { disposed = true; attached.close(); },
      };
    } catch (error) {
      disposed = true; sideband?.close();
      // The host already has the identity if custody succeeded. Failed cleanup
      // remains reconcilable there; do not replace or recreate this session.
      const result = error instanceof LiveTransportError ? error : new LiveTransportError('connection_failed');
      result.providerId = providerId;
      try { await hangup(providerId); result.cleanup = 'requested'; }
      catch { result.cleanup = 'unconfirmed'; }
      throw result;
    }
  };
  // Recovery uses the original durable provider ID, never another creation.
  return Object.assign(connect, { hangup });
}
