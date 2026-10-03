import { useState } from "react";
import type { Claim, VerdictKind } from "@cie/schema";

const MODE_LABEL: Record<string, string> = { INFERENCE: "Inference", HYPOTHESIS: "Hypothesis", FACT: "Fact", FOG: "Fog", HIDDEN: "Withheld" };
const GATE_LABEL: Record<string, string> = { GROUNDING: "Evidence", CONSISTENCY: "Consistency", ADVERSARIAL: "Counter-argument", CALIBRATION: "Calibration", DISPLAY: "Display" };

export function badgeFor(c: Claim): { text: string; cls: string } {
  if (c.state === "REFUTED") return { text: "Refuted", cls: "warn" };
  if (c.state === "STALE") return { text: "Stale", cls: "warn" };
  if (c.state === "CONFIRMED") return { text: "Confirmed by you", cls: "fact" };
  const cls = c.displayMode === "HYPOTHESIS" ? "hyp" : c.displayMode === "HIDDEN" ? "warn" : "inference";
  return { text: MODE_LABEL[c.displayMode] ?? c.displayMode, cls };
}

export function confidenceLine(c: Claim): string {
  if (c.confidence.mode === "CALIBRATED" && c.confidence.band) {
    const b = c.confidence.band;
    return `Calibrated: ${Math.round(b.lower * 100)}–${Math.round(b.upper * 100)}% likely correct (n=${b.sampleCount}, ${Math.round(b.confidenceLevel * 100)}% interval)`;
  }
  const cal = c.gates.find((g) => g.gate === "CALIBRATION");
  return `Confidence not estimated — ${cal?.reasons[0] ?? "no labelled verdicts yet"}`;
}

interface Props { claim: Claim; onVerdict: (claim: Claim, verdict: VerdictKind, explanation: string) => Promise<string | null> }

export function ClaimCard({ claim, onVerdict }: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<VerdictKind | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const b = badgeFor(claim);
  const last = claim.verdicts.at(-1);
  const submit = async () => {
    if (!pending) return;
    if (!text.trim()) { setErr("Say why — verdicts need an explanation."); return; }
    const e = await onVerdict(claim, pending, text.trim());
    if (e) setErr(e); else { setPending(null); setText(""); setErr(null); }
  };
  return (
    <article className={`claim ${claim.displayMode === "HIDDEN" ? "withheld" : ""} ${claim.state === "STALE" ? "stale" : ""}`}>
      <span className={`badge ${b.cls}`}>{b.text}</span>
      <p>{claim.draft.assertion}</p>
      <small className="muted">{claim.draft.rationaleSummary}</small>
      <p className="conf">{confidenceLine(claim)}</p>
      {claim.counterArgument && <p className="counter"><strong>Counter-argument:</strong> {claim.counterArgument}</p>}
      {last && <p className="muted small">{last.verdict.toLowerCase()}ed by {last.actorId}: “{last.explanation}”</p>}
      <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "hide checks" : "show the 5 checks"}</button>
      {open && (
        <table className="gates"><tbody>
          {claim.gates.map((g) => (
            <tr key={g.gate}><th scope="row">{GATE_LABEL[g.gate] ?? g.gate}</th>
              <td><span className={`chip ${g.status.toLowerCase()}`}>{g.status.replace("_", " ").toLowerCase()}</span></td>
              <td>{g.reasons.slice(0, 2).join(" ")}</td></tr>
          ))}
        </tbody></table>
      )}
      {claim.state !== "REFUTED" && (
        <div className="verdicts" role="group" aria-label="Your verdict">
          {(["CONFIRM", "DISPUTE", "REFUTE"] as VerdictKind[]).map((v) => (
            <button key={v} className={`secondary small ${pending === v ? "on" : ""}`} onClick={() => { setPending(pending === v ? null : v); setErr(null); }}>{v === "CONFIRM" ? "Confirm" : v === "DISPUTE" ? "Dispute" : "Refute"}</button>
          ))}
        </div>
      )}
      {pending && (
        <div className="verdict-form">
          <label className="sr" htmlFor={`v-${claim.draft.id}`}>Why do you {pending.toLowerCase()} this?</label>
          <input id={`v-${claim.draft.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Why do you ${pending.toLowerCase()} this?`} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
          <button className="small" onClick={() => void submit()}>Submit {pending.toLowerCase()}</button>
          {err && <span className="warn-text">{err}</span>}
        </div>
      )}
    </article>
  );
}
