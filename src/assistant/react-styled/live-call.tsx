import { useEffect, useRef, useState } from "react";
import { BrowserLiveCall, addLiveCaption, groupLiveCaptions, type LiveCaption, type LiveVoiceState } from "../browser/live-voice.js";

function Headset({ size = 18 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 14v-3a8 8 0 0 1 16 0v5a4 4 0 0 1-4 4h-3"/>
    <rect x="3" y="10" width="4" height="7" rx="2"/><rect x="17" y="10" width="4" height="7" rx="2"/>
  </svg>;
}

/** One call belongs to the selected, authenticated conversation. The main
 * transcript comes from the normal display session, including delegated turns. */
export function LiveCallScreen({ endpoint, threadId, refresh }: {
  endpoint: string; threadId: string; refresh: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const call = useRef<BrowserLiveCall | null>(null);
  const [state, setState] = useState<LiveVoiceState | null>(null);
  const [captions, setCaptions] = useState<readonly LiveCaption[]>([]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => () => {
    const previous = call.current;
    call.current = null;
    void previous?.dispose();
  }, [endpoint, threadId]);
  const status = state?.status ?? "idle";
  useEffect(() => {
    if (status !== "connected") return;
    const current = call.current;
    if (!current) return;
    const abort = new AbortController();
    let pending = false;
    const pulse = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(endpoint + "/heartbeat", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: current.options.id, threadId }), signal: abort.signal,
        });
        if ([401, 403, 404, 409].includes(response.status) && !abort.signal.aborted)
          await current.stop("This call is no longer available.");
      } catch { /* A transient outage can recover during the server lease. */ }
      finally { pending = false; }
    };
    void pulse();
    const timer = setInterval(() => void pulse(), 7000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [endpoint, threadId, status]);
  function start() {
    if (call.current && call.current.getSnapshot().status !== "closed") return;
    const post = async (path: string, body: object, signal?: AbortSignal) => {
      const response = await fetch(endpoint + "/" + path, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, threadId }),
        ...(signal ? { signal } : {}) });
      if (!response.ok) throw new Error("The call request failed.");
      return response.json();
    };
    const next = new BrowserLiveCall({
      id: crypto.randomUUID(), exchange: ({ id, sdp, signal }) => post("call", { id, sdp }, signal),
      end: id => post("end", { id }),
      onChange: value => {
        if (call.current !== next) return;
        setState(value);
        if (value.status === "closed") {
          setCaptions([]);
          refreshRef.current();
          if (!value.error) dialog.current?.close();
        }
      },
      onEvent: event => {
        if (call.current === next) setCaptions(previous => addLiveCaption(previous, event));
      },
    });
    call.current = next;
    setCaptions([]);
    dialog.current?.showModal();
    void next.start();
  }
  const end = () => {
    if (status === "closed") dialog.current?.close();
    else void call.current?.stop();
  };
  const active = status === "connected";
  const label = active ? state?.muted ? "Muted" : "Live" : status === "closed" ? "Ended"
    : status === "end_unconfirmed" ? "End unconfirmed" : status === "closing" ? "Ending…" : "Connecting…";
  return <>
    <button className="hr-chat__talk" type="button" title="Talk live" aria-label="Talk live" onClick={start}><Headset/></button>
    <dialog ref={dialog} className="hr-chat__call" aria-label="Live conversation" onCancel={event => { event.preventDefault(); end(); }}>
      <div className="hr-chat__call-heading"><Headset size={26}/><h3>Live conversation</h3></div>
      <p role="status">{label}</p>
      {captions.length > 0 && <div className="hr-chat__call-captions" aria-label="Live captions">
        {groupLiveCaptions(captions).map(item => <p key={item.id}><strong>{item.role === "user" ? "You" : "Assistant"}</strong> {item.text}</p>)}
      </div>}
      {state?.error && <p role="alert">{state.error}</p>}
      <div className="hr-chat__call-actions">
        {state?.playbackBlocked && <button type="button" onClick={() => void call.current?.play()}>Play audio</button>}
        {active && <button type="button" onClick={() => call.current?.mute()}>{state?.muted ? "Unmute" : "Mute"}</button>}
        <button type="button" disabled={status === "closing"} onClick={end}>{status === "closed" ? "Close" : status === "end_unconfirmed" ? "Retry End" : "End"}</button>
      </div>
    </dialog>
  </>;
}
