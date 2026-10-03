import { useEffect, useRef, useState } from "react";

export interface Message { role: "user" | "assistant"; text: string; at: string; error?: boolean }
interface Props {
  messages: Message[]; referents: { id: string; label: string; source?: "map" | "editor" }[]; busy: boolean; canAsk: boolean;
  examples: string[]; onSend: (text: string) => void; onDropReferent: (id: string) => void;
}

export function ChatPanel({ messages, referents, busy, canAsk, examples, onSend, onDropReferent }: Props) {
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length, busy]);
  const send = () => { const t = text.trim(); if (t && !busy) { onSend(t); setText(""); } };
  return (
    <section className="chat" aria-label="Conversation">
      <h2>Conversation</h2>
      <div className="messages" role="log" aria-live="polite" aria-label="Conversation history" tabIndex={0}>
        {messages.length === 0 && (
          <div className="muted">
            <p>Ask what you're trying to understand, paste a stack trace to investigate, or select elements on the map and ask how they relate.</p>
            {canAsk && <ul className="examples">{examples.map((x) => <li key={x}><button className="link" onClick={() => onSend(x)} disabled={busy}>{x}</button></li>)}</ul>}
          </div>
        )}
        {messages.map((m, i) => <div key={i} className={`msg ${m.role} ${m.error ? "err" : ""}`}><span className="who">{m.role === "user" ? "You" : "Assistant"}</span><p>{m.text}</p></div>)}
        {busy && <div className="msg assistant"><span className="who">Assistant</span><p className="muted">Working…</p></div>}
        <div ref={end} />
      </div>
      {referents.length > 0 && (
        <div className="referents" role="group" aria-label="Selected elements the next message refers to">
          {referents.slice(0, 6).map((r) => <span key={r.id} className={`ref ${r.source === "editor" ? "editor" : ""}`} title={r.source === "editor" ? "From your editor selection" : "Selected on the map"}>{r.source === "editor" ? "⌨ " : ""}{r.label}<button aria-label={`Remove ${r.label} from the selection`} onClick={() => onDropReferent(r.id)}>×</button></span>)}
          {referents.length > 6 && <span className="muted small">+{referents.length - 6} more</span>}
        </div>
      )}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <label className="sr" htmlFor="chat-input">Message</label>
        <textarea id="chat-input" rows={3} value={text} placeholder={referents.length ? "Ask about the selected elements…" : "Ask a question, or paste a stack trace…"}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} disabled={!canAsk} />
        <button type="submit" disabled={!text.trim() || busy || !canAsk}>Send</button>
      </form>
    </section>
  );
}
