import { EvidencePanel } from "./EvidencePanel.tsx";
import { useEffect, useRef, useState } from "react";
import { buttonFeedback } from "./button.ts";
import { CHAT_QUESTION_MAX_CHARS } from "@cie/schema";
import type { EvidenceTrace, AnswerValidationSummary, ChatAnalysisResult } from "@cie/schema";

/** One alternative view the router considered for the same question. */
export interface MessageAlt { form: string; kind?: string; chartCode?: string; name: string; question: string; prompt?: string;
  response?: { responseId: string; viewId: string; revision: string; answerContext?: string; snapshotId?: string; seeds: string[]; scope: "subject" | "repository"; subject?: string };
}

export interface Message {
  evidenceTrace?: EvidenceTrace;
  id?: string; role: "user" | "assistant"; text: string; at: string; error?: boolean; results?: ChatAnalysisResult[]; validation?: AnswerValidationSummary;
  /** Other chart forms the router considered equally valid for the same question. */
  alternatives?: MessageAlt[];
  /** The pre-answer trace (why this form, the bare caption) kept once `text` carries the composed answer; shown collapsed. */
  thinking?: string;
  providerWizard?: boolean;
}
interface Props {
  messages: Message[]; referents: { id: string; label: string; source?: "map" | "editor" | "cell" }[]; busy: boolean; canAsk: boolean;
  examples: string[]; onSend: (text: string) => void; onDropReferent: (id: string) => void;
  onNewContext: () => void;
  /** Seeded from other panels (e.g. "ask about this finding"); a new `n` replaces the composer's text. */
  seed?: { text: string; n: number };
  onShowResult?: (result: ChatAnalysisResult) => void;
  onCreateProvider?: () => void;
  /** Show the same question rendered as a different chart form. */
  onShowAlt?: (alt: MessageAlt) => void;
  onContinueInvestigation?: (id: string) => void;
  onOpenEvidence?: (revision:string,entityId:string)=>void;
  retryAvailable?: boolean;
  onRetry?: () => void;
}

export function ChatPanel({ messages, referents, busy, canAsk, examples, onSend, onDropReferent, onNewContext, seed, onShowResult, onCreateProvider, onShowAlt, onContinueInvestigation, onOpenEvidence, retryAvailable, onRetry }: Props) {
  const [text, setText] = useState("");
  const [referentsExpanded, setReferentsExpanded] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length, busy]);
  useEffect(() => { if (seed?.n) setText(seed.text); }, [seed?.n, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = () => { const t = text.trim(); if (t && !busy) { onSend(t); setText(""); } };
  const sendFb = buttonFeedback({ busy, skeleton: busy });
  return (
    <section className="chat" aria-label="Conversation">
      <div className="between"><h2>Conversation</h2><button className="link small" onClick={onNewContext} disabled={busy} aria-label="Start a new conversation context">＋ New context</button></div>
      <div className="messages" role="log" aria-live="polite" aria-label="Conversation history" tabIndex={0}>
        {messages.length === 0 && (
          <div className="muted">
            <p>Ask what you're trying to understand, paste a stack trace to investigate, or select elements on the map and ask how they relate.</p>
            {canAsk && <ul className="examples">{examples.map((x) => <li key={x}><button className="link" onClick={() => { setText(x); textareaRef.current?.focus(); }} disabled={busy}>{x}</button></li>)}</ul>}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? "err" : ""}`}>
            <span className="who">{m.role === "user" ? "You" : "Assistant"}</span>
            <p>{m.text}</p>
            {m.evidenceTrace && <EvidencePanel trace={m.evidenceTrace} onOpen={onOpenEvidence} />}
            {m.thinking && (
              <details className="thinking">
                <summary>How this was found</summary>
                <p className="muted small">{m.thinking}</p>
              </details>
            )}
            {m.providerWizard && (
              <div className="chat-results">
                <button className="secondary small" disabled={busy} onClick={onCreateProvider}>Create a provider</button>
              </div>
            )}
            {m.validation && <div className="chat-results" role="group" aria-label="Answer validation">
              <span className="muted small">{m.validation.status === "SUPPORTED" ? "Answer review passed" : "Unresolved investigation"}</span>
              {m.validation.investigation?.nextAction === "continue" && <button className="secondary small" disabled={busy} onClick={() => onContinueInvestigation?.(m.validation!.investigation!.id)}>Continue investigation</button>}
              {m.validation.investigation?.recovery && <details className="thinking"><summary>Recovery plan</summary>
                <p>{m.validation.investigation.recovery.reason}</p>
                <p className="muted small">{m.validation.investigation.recovery.retainedObservations} reusable observation(s) retained; {m.validation.investigation.recovery.remainingSourceReads} source read(s) unfinished.</p>
                <ul>{m.validation.investigation.recovery.actions.map(action => <li key={action.id}>Read <code>{action.id}</code> from character offset {action.offset}.</li>)}</ul>
              </details>}
              <details className="thinking"><summary>Answer review</summary>
                <p className="muted small">{m.validation.review.requirements.join("; ")}</p>
                <p className="muted small">{m.validation.review.gaps.join("; ")}</p>
                <p className="muted small">Repair attempts: {m.validation.repairAttempts}/2. A model review is an evidence check, not a proof of runtime behavior.</p>
              </details>
            </div>}
            {/* Multi-step analysis results — "Show <step title>" */}
            {m.results && (
              <div className="chat-results" role="group" aria-label="Analysis views">
                {m.results.filter((r) => r.view).map((r, j) => (
                  <button key={j} className="secondary small" disabled={busy} onClick={() => onShowResult?.(r)}>
                    Show {r.title}
                  </button>
                ))}
              </div>
            )}
            {/* Alternative chart forms for the same question */}
            {m.alternatives && m.alternatives.length > 0 && (
              <div className="chat-alts" role="group" aria-label="Alternative views for the same question">
                <span className="chat-alts-label">Explore this answer as</span>
                {m.alternatives.map((a, j) => (
                  <button
                    key={j}
                    className="secondary small"
                    disabled={busy}
                    title={`Explore these findings as a ${a.name}`}
                    onClick={() => onShowAlt?.(a)}
                  >
                    {a.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="msg assistant"><span className="who">Assistant</span><p className="muted">Working…</p></div>}
        <div ref={end} />
      </div>
      {retryAvailable && <div className="chat-results" role="group" aria-label="Interrupted investigation recovery">
        <button className="secondary small" disabled={busy || !canAsk} onClick={onRetry}>Retry investigation</button>
        <p className="muted small">Retry the original request with its retained progress. If it is still running, wait for it to finish or its recovery lease to expire.</p>
      </div>}
      {referents.length > 0 && (
        <div className="referents" role="group" aria-label="Selected elements the next message refers to">
          {(() => {
            const chip = (r: { id: string; label: string; source?: "map" | "editor" | "cell" }) => (
              <span key={r.id} className={`ref ${r.source === "editor" ? "editor" : ""}`} title={r.source === "editor" ? "From your editor selection" : r.source === "cell" ? "Selected in the matrix: the code of this row and column" : "Selected on the map"}>
                {r.source === "editor" ? "⌨ " : ""}{r.label}
                <button aria-label={`Remove ${r.label} from the selection`} onClick={() => onDropReferent(r.id)}>×</button>
              </span>
            );
            if (referents.length <= 6) return referents.map(chip);
            if (!referentsExpanded) return (
              <>
                {referents.slice(0, 6).map(chip)}
                <button className="link small" onClick={() => setReferentsExpanded(true)}>+{referents.length - 6} more</button>
              </>
            );
            return (
              <>
                {referents.map(chip)}
                <button className="link small" onClick={() => { referents.forEach(ref => onDropReferent(ref.id)); setReferentsExpanded(false); }}>Clear all</button>
                <button className="link small" onClick={() => setReferentsExpanded(false)}>Show less</button>
              </>
            );
          })()}
        </div>
      )}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <label className="sr" htmlFor="chat-input">Message</label>
        <textarea ref={textareaRef} id="chat-input" rows={3} value={text} placeholder={referents.length ? "Ask about the selected elements…" : "Ask a question, or paste a stack trace…"}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} disabled={!canAsk} />
        {text.length > CHAT_QUESTION_MAX_CHARS && (
          <p className="muted small" role="status">Only the first {CHAT_QUESTION_MAX_CHARS.toLocaleString()} characters ({text.length.toLocaleString()} typed) will be answered; the rest is truncated.</p>
        )}
        <button type="submit" className={sendFb.className} aria-busy={sendFb["aria-busy"]} disabled={!text.trim() || busy || !canAsk}>{sendFb.spinner && <span className="spinner" aria-hidden="true" />}Send</button>
      </form>
    </section>
  );
}
