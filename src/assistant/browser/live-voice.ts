/** Headless GPT-Live WebRTC client. The host owns authenticated HTTP endpoints,
 * durable call admission/termination and captions; no tools execute in a browser. */
export interface LiveVoiceState {
  status: 'idle' | 'starting' | 'connected' | 'closing' | 'closed' | 'end_unconfirmed';
  muted: boolean;
  playbackBlocked: boolean;
  listening: boolean;
  error: string | null;
  startupTimings: Readonly<Record<string, number>>;
}
export interface LiveBrowserEvent { type: string; [key: string]: unknown }
export interface BrowserLiveCallOptions {
  id: string;
  /** Must reserve id durably before provider IO. Never retry session creation. */
  exchange(input: { id: string; sdp: string; signal: AbortSignal }): Promise<{ sdp: string }>;
  /** Idempotently end/tombstone this original id, including pending startup.
   * Resolve confirmed only after the host's authoritative termination receipt. */
  end(id: string): Promise<{ confirmed: boolean }>;
  onChange?: (state: LiveVoiceState) => void;
  onEvent?: (event: LiveBrowserEvent) => void;
  onError?: (error: unknown) => void;
  createPeer?: () => RTCPeerConnection;
  microphone?: () => Promise<MediaStream>;
  createAudio?: () => HTMLAudioElement;
  clock?: () => number;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
  lifecycle?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export class BrowserLiveCall {
  #state: LiveVoiceState = { status: 'idle', muted: false, playbackBlocked: false, listening: false,
    error: null, startupTimings: {} };
  #listeners = new Set<() => void>();
  #abort = new AbortController();
  #peer: RTCPeerConnection | undefined;
  #channel: RTCDataChannel | undefined;
  #stream: MediaStream | undefined;
  #audio: HTMLAudioElement | undefined;
  #remoteTracks = new Set<MediaStreamTrack>();
  #dispatched = false;
  #stopping: Promise<void> | undefined;
  #disposed = false;
  #providerId?: string;
  #failure: string | null = null;
  #startedAt?: number;
  #ready?: () => void;
  #readyFailure?: (error: Error) => void;
  #clock: () => number;
  #lifecycle: BrowserLiveCallOptions['lifecycle'];
  #onPageHide = () => { void this.stop(); };
  constructor(readonly options: BrowserLiveCallOptions) { this.#clock = options.clock ?? (() => performance.now()); }
  getSnapshot = (): LiveVoiceState => this.#state;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  get peer() { return this.#peer; }
  get audio() { return this.#audio; }
  get remoteTracks(): readonly MediaStreamTrack[] { return [...this.#remoteTracks]; }
  #set(next: Partial<LiveVoiceState>) {
    this.#state = { ...this.#state, ...next };
    this.options.onChange?.(this.#state);
    for (const listener of this.#listeners) listener();
  }
  #mark(key: string) {
    if (this.#startedAt === undefined || Object.hasOwn(this.#state.startupTimings, key)) return;
    this.#set({ startupTimings: { ...this.#state.startupTimings, [key]: Math.max(0, Math.round(this.#clock() - this.#startedAt)) } });
  }
  #current() { this.#abort.signal.throwIfAborted(); }
  #report(error: unknown) { try { this.options.onError?.(error); } catch { /* Diagnostics cannot prevent cleanup. */ } }
  #listening() {
    this.#set({ listening: this.#state.status === 'connected' && !this.#state.muted &&
      Boolean(this.#stream?.getAudioTracks().some(t => t.readyState === 'live' && t.enabled && !t.muted)) });
  }
  async start(): Promise<void> {
    if (this.#state.status !== 'idle' || this.#disposed || this.#abort.signal.aborted) return;
    this.#startedAt = this.#clock(); this.#set({ status: 'starting', error: null, startupTimings: { start_called_ms: 0 } });
    this.#lifecycle = this.options.lifecycle ?? (typeof window === 'undefined' ? undefined : window);
    this.#lifecycle?.addEventListener('pagehide', this.#onPageHide);
    try {
      const stream = await (this.options.microphone ?? (() => navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      })))();
      if (this.#abort.signal.aborted) { for (const track of stream.getTracks()) track.stop(); return; }
      this.#stream = stream; this.#mark('microphone_ready_ms');
      const peer = (this.options.createPeer ?? (() => new RTCPeerConnection()))(); this.#peer = peer;
      peer.addEventListener('connectionstatechange', () => {
        if (['disconnected', 'failed', 'closed'].includes(peer.connectionState) && !this.#abort.signal.aborted) void this.#fail();
      });
      peer.addEventListener('track', event => {
        if (this.#abort.signal.aborted) { event.track.stop(); return; }
        this.#remoteTracks.add(event.track);
        const audio = this.#audio ??= (this.options.createAudio ?? (() => new Audio()))();
        audio.autoplay = true;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.play();
      });
      for (const track of stream.getAudioTracks()) {
        // A call is not listening before both SDP and session.started succeed.
        track.enabled = false; peer.addTrack(track, stream);
        track.addEventListener('mute', () => this.#listening());
        track.addEventListener('unmute', () => this.#listening());
        track.addEventListener('ended', () => { if (!this.#abort.signal.aborted) void this.#fail(); });
      }
      const channel = peer.createDataChannel('oai-events'); this.#channel = channel;
      const ready = new Promise<void>((resolve, reject) => { this.#ready = resolve; this.#readyFailure = reject; });
      // Provider errors may arrive while the SDP request is still pending.
      void ready.catch(() => {});
      channel.addEventListener('message', event => this.#event(event.data));
      channel.addEventListener('close', () => {
        if (!this.#abort.signal.aborted) { this.#readyFailure?.(new Error('Voice connection closed.')); void this.#fail(); }
      });
      const offer = await peer.createOffer(); this.#current(); this.#mark('offer_created_ms');
      await peer.setLocalDescription(offer); this.#current();
      if (peer.iceGatheringState !== 'complete') {
        let check: () => void = () => {};
        try { await this.#wait(new Promise<void>(resolve => {
          check = () => { if (peer.iceGatheringState === 'complete') resolve(); };
          peer.addEventListener('icegatheringstatechange', check); check();
        }), 10_000); } finally { peer.removeEventListener('icegatheringstatechange', check); }
      }
      this.#current(); this.#mark('ice_ready_ms');
      const sdp = peer.localDescription?.sdp;
      if (!sdp?.startsWith('v=0') || new TextEncoder().encode(sdp).length > 65_536) throw new Error('Invalid voice offer.');
      this.#dispatched = true;
      const answer = await this.options.exchange({ id: this.options.id, sdp,
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(this.options.startupTimeoutMs ?? 45_000)]) });
      this.#current(); this.#mark('session_api_response_ms');
      if (!answer.sdp?.startsWith('v=0') || new TextEncoder().encode(answer.sdp).length > 262_144) throw new Error('Invalid voice answer.');
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp }); this.#current(); this.#mark('remote_description_ready_ms');
      await this.#wait(ready, 20_000); this.#current(); this.#mark('session_started_ms');
      for (const track of stream.getAudioTracks()) track.enabled = !this.#state.muted;
      this.#set({ status: 'connected' }); this.#listening();
    } catch (error) { if (!this.#abort.signal.aborted) { this.#report(error); await this.#fail(); } }
  }
  #event(raw: unknown) {
    if (this.#abort.signal.aborted) return;
    try {
      if (typeof raw !== 'string' || raw.length > 262_144) throw new Error('Invalid voice event.');
      const event = JSON.parse(raw) as LiveBrowserEvent;
      if (!event || typeof event.type !== 'string') throw new Error('Invalid voice event.');
      if (event.type === 'error') throw new Error('OpenAI reported a voice error.');
      if (event.type === 'session.started' || event.type === 'session.closed') {
        const session = event.session as { id?: unknown } | undefined;
        if (!session || typeof session.id !== 'string' || !session.id || session.id.length > 256 ||
          this.#providerId && this.#providerId !== session.id) throw new Error('Invalid voice session.');
        this.#providerId = session.id;
        if (event.type === 'session.started') this.#ready?.();
        else void this.stop(); // Host receipt, not a browser event, proves termination.
      }
      if (event.type === 'session.output_transcript.delta') this.#mark('first_output_transcript_ms');
      this.options.onEvent?.(event);
    } catch { this.#readyFailure?.(new Error('Voice connection failed.')); void this.#fail(); }
  }
  async #wait<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(milliseconds)]);
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  mute() {
    if (this.#state.status !== 'connected') return;
    const muted = !this.#state.muted;
    for (const track of this.#stream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.#set({ muted }); this.#listening();
  }
  async play() {
    const audio = this.#audio;
    if (!audio || this.#abort.signal.aborted) return;
    try { await audio.play(); if (!this.#abort.signal.aborted) this.#set({ playbackBlocked: false }); else audio.pause(); }
    catch { if (!this.#abort.signal.aborted) this.#set({ playbackBlocked: true }); }
  }
  async #fail() {
    if (this.#abort.signal.aborted) return;
    await this.stop('Voice could not connect or was interrupted. Your saved conversation remains available.');
  }
  stop(error: string | null = null): Promise<void> {
    if (this.#stopping) return this.#stopping;
    if (this.#state.status === 'closed') return Promise.resolve();
    if (error) this.#failure = error;
    this.#abort.abort(); this.#readyFailure?.(new Error('Voice ended.'));
    this.#set({ status: 'closing', muted: true, listening: false, error: this.#failure });
    // End local audio immediately while the trusted server drains final usage.
    for (const track of this.#stream?.getTracks() ?? []) { track.enabled = false; track.stop(); }
    for (const track of this.#remoteTracks) track.enabled = false;
    this.#audio?.pause();
    this.#stopping = (async () => {
      let confirmed = !this.#dispatched;
      try {
        if (this.#dispatched) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { confirmed = (await Promise.race([this.options.end(this.options.id),
            new Promise<{ confirmed: boolean }>(resolve => { timer = setTimeout(() => resolve({ confirmed: false }), this.options.closeTimeoutMs ?? 20_000); }),
          ])).confirmed; } finally { clearTimeout(timer); }
        }
      } catch (cause) { this.#report(cause); }
      finally {
        // If the server cannot confirm termination, ask the original provider
        // channel to close too, without claiming this request proves completion.
        if (!confirmed && this.#channel?.readyState === 'open') {
          try { this.#channel.send(JSON.stringify({ type: 'session.close' })); } catch { /* Host reconciliation retains the original identity. */ }
        }
        this.#release();
        this.#set({ status: confirmed ? 'closed' : 'end_unconfirmed', playbackBlocked: false, error: this.#failure,
          ...(!confirmed ? { error: 'Microphone stopped. The call end is unconfirmed. Retry ending this call.' } : {}) });
      }
    })().finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }
  #release() {
    this.#lifecycle?.removeEventListener('pagehide', this.#onPageHide);
    this.#channel?.close(); this.#peer?.close();
    for (const track of this.#remoteTracks) track.stop(); this.#remoteTracks.clear();
    if (this.#audio) this.#audio.srcObject = null;
    this.#channel = undefined; this.#peer = undefined; this.#stream = undefined; this.#audio = undefined;
  }
  dispose() { this.#disposed = true; this.#listeners.clear(); return this.stop(); }
}

export interface LiveCaption { id: string; role: 'user' | 'assistant'; text: string; start: number; end: number }
/** Display-only window. Server-side durable capture is the transcript authority. */
export function addLiveCaption(fragments: readonly LiveCaption[], event: LiveBrowserEvent): readonly LiveCaption[] {
  if (!['session.input_transcript.delta', 'session.output_transcript.delta'].includes(event.type) ||
    typeof event.delta !== 'string' || typeof event.event_id !== 'string' || !event.event_id ||
    typeof event.start_ms !== 'number' || !Number.isFinite(event.start_ms) || event.start_ms < 0 ||
    typeof event.end_ms !== 'number' || !Number.isFinite(event.end_ms) || event.end_ms < event.start_ms) return fragments;
  if (fragments.some(f => f.id === event.event_id)) return fragments;
  const next: LiveCaption = { id: event.event_id, role: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
    text: event.delta, start: event.start_ms, end: event.end_ms };
  return [...fragments, next].sort((a, b) => a.start - b.start).slice(-160);
}
export function groupLiveCaptions(fragments: readonly LiveCaption[]): LiveCaption[] {
  const groups: LiveCaption[] = [];
  for (const fragment of fragments) {
    const last = groups.at(-1);
    if (last?.role === fragment.role && fragment.start - last.end < 800) {
      last.text += fragment.text; last.end = Math.max(last.end, fragment.end);
    } else groups.push({ ...fragment });
  }
  return groups;
}

export interface LiveAudioStats {
  id: string; type: string; kind?: string; trackIdentifier?: string; playoutId?: string;
  totalAudioEnergy?: number; totalSamplesDuration?: number;
}
/** Speaking requires observed local playout of audible samples. Captions and
 * decoded packets alone cannot prove the person heard audio. */
export class LiveOutputPlayback {
  #samples = new Map<string, { energy: number; duration: number; playout: number; now: number }>();
  #audibleAt: number | null = null;
  reset() { this.#samples.clear(); this.#audibleAt = null; }
  observe(reports: readonly LiveAudioStats[], { trackIds = [], now = Date.now() }: { trackIds?: readonly string[]; now?: number } = {}) {
    const rows = new Map(reports.map(row => [row.id, row]));
    const next = new Map<string, { energy: number; duration: number; playout: number; now: number }>();
    for (const row of reports) {
      if (row.type !== 'inbound-rtp' || row.kind !== 'audio' || !row.trackIdentifier || !trackIds.includes(row.trackIdentifier)) continue;
      const playout = row.playoutId ? rows.get(row.playoutId) : undefined;
      if (playout?.type !== 'media-playout' || playout.kind !== 'audio') continue;
      const energy = row.totalAudioEnergy, duration = row.totalSamplesDuration, played = playout.totalSamplesDuration;
      if (typeof energy !== 'number' || typeof duration !== 'number' || typeof played !== 'number' ||
        ![energy, duration, played].every(value => Number.isFinite(value) && value >= 0)) continue;
      const key = `${row.id}:${row.playoutId}`, previous = this.#samples.get(key);
      next.set(key, { energy, duration, playout: played, now });
      if (!previous || now <= previous.now || now - previous.now > 1500) continue;
      const deltaDuration = duration - previous.duration, deltaEnergy = energy - previous.energy;
      if (deltaDuration > 0 && deltaEnergy >= 0 && played > previous.playout && Math.sqrt(deltaEnergy / deltaDuration) >= 0.005) this.#audibleAt = now;
    }
    this.#samples = next;
  }
  isSpeaking(now = Date.now()) { return this.#audibleAt !== null && now >= this.#audibleAt && now - this.#audibleAt <= 600; }
}
