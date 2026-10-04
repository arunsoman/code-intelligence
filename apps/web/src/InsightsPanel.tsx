import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ViewSpec } from "@cie/schema";
import { call } from "./api.ts";

type Tab = "security" | "config" | "identity" | "changes" | "runtime" | "sources" | "team" | "evaluation";
const TABS: { id: Tab; label: string }[] = [
  { id: "security", label: "Security" }, { id: "config", label: "Configuration" }, { id: "identity", label: "Identity" }, { id: "changes", label: "Changes" },
  { id: "runtime", label: "Runtime" }, { id: "sources", label: "Sources" }, { id: "team", label: "Team" }, { id: "evaluation", label: "Evaluation" },
];
const key = () => crypto.randomUUID();
const pct = (x: { value: number | null; lower: number; upper: number; n: number }) => (x.value === null ? "n/a" : `${Math.round(x.value * 100)}% (${Math.round(x.lower * 100)}–${Math.round(x.upper * 100)}%, n=${x.n})`);

function useCall<T>() {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const run = useCallback(async (component: string, op: string, body: unknown = {}, mutating = false): Promise<T | null> => {
    setBusy(true); setError(null);
    const r = await call<T>(component, op, body, mutating ? key() : undefined);
    setBusy(false);
    if (!r.ok) { setError(r.error.message); return null; }
    setData(r.value); setWarnings(r.metadata.warnings ?? []);
    return r.value;
  }, []);
  return { data, setData, error, setError, busy, warnings, run };
}
const Status = ({ error, busy, warnings }: { error: string | null; busy: boolean; warnings?: string[] }) => (
  <>
    {busy && <p role="status" className="muted">Working…</p>}
    {error && <p role="alert" className="warn-text">{error}</p>}
    {(warnings ?? []).map((w, i) => <p key={i} className="muted small">{w}</p>)}
  </>
);
const Badge = ({ children, kind = "inference" }: { children: ReactNode; kind?: "fact" | "inference" | "warn" | "hyp" }) => <span className={`badge ${kind}`}>{children}</span>;
const statusKind = (s: string): "fact" | "inference" | "warn" | "hyp" => (["RESOLVED", "HEALTHY", "EVALUATED", "ALARM", "CONFIRMED", "SUPPORTED"].includes(s) ? "fact" : ["ABSENT", "CONFLICTING", "EXPIRED", "REVERSED", "UNMEASURED_MODEL", "NEVER_EVALUATED", "UNREACHABLE"].includes(s) ? "warn" : ["AMBIGUOUS", "PARTIAL", "RATE_LIMITED", "PROPOSED", "DISPUTED", "CANDIDATE"].includes(s) ? "hyp" : "inference");

export function InsightsPanel({ revision, view, onClose }: { revision: string; view: ViewSpec | null; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("security");
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && (e.target as HTMLElement).getAttribute("role") === "tab") {
      const i = TABS.findIndex((t) => t.id === tab), n = (i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
      setTab(TABS[n].id); requestAnimationFrame(() => document.getElementById(`tab-${TABS[n].id}`)?.focus());
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="modal defect-panel" role="dialog" aria-modal="true" aria-label="Insights" tabIndex={-1} onKeyDown={onKey}>
        <div className="defect-heading"><h2>Insights</h2><button autoFocus onClick={onClose}>Close</button></div>
        <p className="muted small">Revision <code>{revision}</code>. Everything here is derived from the code and labelled with how sure it is; nothing certifies anything.</p>
        <div role="tablist" aria-label="Insight areas" className="tabs">
          {TABS.map((t) => <button key={t.id} id={`tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "security" && <Security revision={revision} />}
          {tab === "config" && <Config revision={revision} />}
          {tab === "identity" && <Identity revision={revision} />}
          {tab === "changes" && <Changes revision={revision} view={view} />}
          {tab === "runtime" && <Runtime revision={revision} />}
          {tab === "sources" && <Sources revision={revision} />}
          {tab === "team" && <Team revision={revision} view={view} />}
          {tab === "evaluation" && <Evaluation />}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- C25
interface Finding { id: string; ruleId: string; ruleVersion: number; ruleDigest: string; title: string; severity: string; state: string; summary: string; evidenceIds: string[]; assumptions: string[]; counterArgument: string; disclaimer: string; source: string }
function Security({ revision }: { revision: string }) {
  const f = useCall<Finding[]>(); const g = useCall<{ ok: boolean; basis: string; reasons: string[]; finding: Finding }>(); const n = useCall<{ markdown: string; missingControls: string[] }>();
  const [policies, setPolicies] = useState("POL-PII-1, POL-AUTHZ-1");
  const [shown, setShown] = useState<Record<string, string>>({});
  const analyze = () => f.run("C25", "analyze", { revision, policyIds: policies.split(",").map((x) => x.trim()).filter(Boolean) }, true);
  const gate = async (id: string) => { const r = await g.run("C25", "gateSecurityAlarm", { findingId: id, proofEvidenceIds: f.data?.find((x) => x.id === id)?.evidenceIds ?? [] }, true); if (r) setShown({ ...shown, [id]: r.ok ? `Alarm: ${r.basis.replace("_", " ").toLowerCase()}` : `Stays a candidate. ${r.reasons.join(" ")}` }); await analyzeKeep(); };
  const analyzeKeep = async () => { const r = await call<Finding[]>("C25", "analyze", { revision, policyIds: policies.split(",").map((x) => x.trim()).filter(Boolean) }, key()); if (r.ok) f.setData(r.value); };
  return <>
    <p className="notice">A finding is a candidate from static analysis. <strong>No finding does not mean safe</strong>, and nothing here certifies compliance. A candidate becomes an alarm only with deterministic proof or two authorised confirmations.</p>
    <div className="row"><label htmlFor="pols" className="sr">Required policy ids</label><input id="pols" value={policies} onChange={(e) => setPolicies(e.target.value)} aria-label="Required policy ids, comma separated" /><button onClick={() => void analyze()} disabled={f.busy}>Analyze</button>
      <button className="secondary" disabled={!f.data?.length} onClick={() => void n.run("C25", "buildAuditNarrative", { revision, findingIds: f.data!.map((x) => x.id) })}>Audit narrative</button></div>
    <Status error={f.error ?? g.error ?? n.error} busy={f.busy || g.busy || n.busy} warnings={f.warnings.slice(0, 1)} />
    {f.data && f.data.length === 0 && <p className="muted">No candidates found by the current rules. That is not a statement that the code is safe.</p>}
    <ul className="cards">{(f.data ?? []).map((x) => (
      <li key={x.id} className="card">
        <div><Badge kind={x.severity === "high" ? "warn" : "hyp"}>{x.severity}</Badge><Badge kind={statusKind(x.state)}>{x.state === "ALARM" ? "alarm (gate satisfied)" : "candidate"}</Badge><Badge>{x.ruleId}@{x.ruleVersion}</Badge></div>
        <p><strong>{x.title}.</strong> {x.summary}</p>
        <p className="counter"><strong>Counter-argument:</strong> {x.counterArgument}</p>
        <details><summary>Assumes</summary><ul>{x.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></details>
        <div className="row"><button className="secondary small" onClick={() => void gate(x.id)}>Check the alarm gate</button><span className="muted small">{x.evidenceIds.length} evidence item(s) · rule digest {x.ruleDigest}</span></div>
        {shown[x.id] && <p role="status" className="small">{shown[x.id]}</p>}
      </li>))}</ul>
    {n.data && <><h3>Audit narrative</h3>{n.data.missingControls.length > 0 && <p className="muted small">Not declared: {n.data.missingControls.join(", ")}</p>}<pre tabIndex={0} aria-label="Audit narrative" className="narr">{n.data.markdown}</pre></>}
  </>;
}

// ---------------------------------------------------------------- C06
interface Artifact { id: string; kind: string; name: string; status: string; detail: string; candidates: string[]; deployed: string }
function Config({ revision }: { revision: string }) {
  const a = useCall<{ artifacts: Artifact[]; diagnostics: { code: string; message: string }[]; notice: string }>();
  useEffect(() => { void a.run("C06", "extractArtifacts", { revision }); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const kinds = ["route", "table", "queue", "flag"];
  return <>
    <Status error={a.error} busy={a.busy} />
    {a.data && <>
      <p className="notice">{a.data.notice}</p>
      {kinds.map((k) => { const rows = a.data!.artifacts.filter((x) => x.kind === k); return (
        <section key={k}><h3>{{ route: "Routes → handlers", table: "Tables ↔ migrations", queue: "Queues", flag: "Feature flags" }[k]} <small className="muted">({rows.length})</small></h3>
          {rows.length === 0 ? <p className="muted small">None found.</p> : <table className="gates"><tbody>{rows.map((r) => <tr key={r.id}><th scope="row">{r.name}</th><td><Badge kind={statusKind(r.status)}>{r.status.replace(/_/g, " ").toLowerCase()}</Badge></td><td>{r.detail}{r.candidates.length > 0 && <span className="muted small"> Candidates: {r.candidates.join(", ")}</span>}</td></tr>)}</tbody></table>}
        </section>); })}
      <h3>Diagnostics <small className="muted">({a.data.diagnostics.length})</small></h3>
      <ul>{a.data.diagnostics.map((d, i) => <li key={i}><code>{d.code}</code> {d.message}</li>)}</ul>
    </>}
  </>;
}

// ---------------------------------------------------------------- C08
interface Proposal { id: string; kind: string; state: string; version: number; oldIds: string[]; newIds: string[]; evidence: string[]; strength: string }
function Identity({ revision }: { revision: string }) {
  const p = useCall<Proposal[]>(); const d = useCall<{ name: string; canon: { entityId: string }[] }[]>(); const v = useCall<Proposal>();
  const load = useCallback(() => { void p.run("C08", "proposals", { revision }); void d.run("C08", "duplicateNames", { revision }); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  const decide = async (x: Proposal, verdict: "CONFIRM" | "DISPUTE" | "REFUTE") => { await v.run("C08", "applyIdentityVerdict", { proposalId: x.id, verdict, expectedVersion: x.version }, true); load(); };
  const short = (id: string) => id.replace(/^[a-z]+:/, "");
  return <>
    <p className="notice">A name alone never merges two things. An identical body that appears once on each side is a supported rename; splits, merges and ambiguous matches stay proposals until you decide, and any decision can be reversed.</p>
    <Status error={p.error ?? v.error} busy={p.busy} />
    <h3>Identity proposals <small className="muted">({p.data?.length ?? 0})</small></h3>
    {p.data?.length === 0 && <p className="muted">No renames, splits or merges were detected between indexed revisions.</p>}
    <ul className="cards">{(p.data ?? []).map((x) => (
      <li key={x.id} className="card">
        <div><Badge>{x.kind.toLowerCase()}</Badge><Badge kind={statusKind(x.state)}>{x.state.toLowerCase()}</Badge><Badge kind="hyp">{x.strength.replace("_", " ").toLowerCase()}</Badge></div>
        <p><code>{x.oldIds.map(short).join(", ")}</code> → <code>{x.newIds.map(short).join(", ")}</code></p>
        <p className="muted small">{x.evidence.join("; ")}</p>
        <div className="row" role="group" aria-label={`Decide on this ${x.kind.toLowerCase()}`}>
          {x.state !== "CONFIRMED" && x.state !== "SUPPORTED" && x.state !== "REVERSED" && <button className="secondary small" onClick={() => void decide(x, "CONFIRM")}>Confirm</button>}
          {x.state === "PROPOSED" && <button className="secondary small" onClick={() => void decide(x, "DISPUTE")}>Dispute</button>}
          {x.state !== "REVERSED" && <button className="secondary small" onClick={() => void decide(x, "REFUTE")}>{x.state === "PROPOSED" ? "Reject" : "Reverse"}</button>}
        </div>
      </li>))}</ul>
    <h3>Same name, different things <small className="muted">({d.data?.length ?? 0})</small></h3>
    <ul>{(d.data ?? []).map((x) => <li key={x.name}><strong>{x.name}</strong>: {x.canon.map((c) => short(c.entityId)).join(" · ")}</li>)}</ul>
  </>;
}

// ---------------------------------------------------------------- C23 / C07
interface ChangeSet { base: string; head: string; textDiff: { filesChanged: number; symbolsTouched: number }; consequences: { id: string; kind: string; text: string; displayMode: string }[]; blastRadius: { entityId: string; dependents: number; files: string[] }[]; testImpact: { entityId: string; lost: string[]; gained: string[] }[]; entities: { base: string | null; head: string | null; change: string }[] }
function Changes({ revision, view }: { revision: string; view: ViewSpec | null }) {
  const revs = useCall<{ id: string; createdAt: string; files: number }[]>(); const c = useCall<ChangeSet>(); const arch = useCall<any>();
  const [base, setBase] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  useEffect(() => { void (async () => { const st = await call<{ revision: { repoRoot: string } | null }>("C01", "status", { revision }); const r = await revs.run("C07", "listRevisions", { repoRoot: st.ok ? st.value.revision?.repoRoot : undefined }); const other = r?.find((x) => x.id !== revision); if (other) setBase(other.id); })(); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const nodes = (view?.nodes ?? []).filter((n) => ["function", "method", "class"].includes(n.kind));
  return <>
    <p className="notice">A consequence says what is true in one revision and not the other. It never says what caused it; commit chronology is observed, the reasons stay inferences.</p>
    <div className="row"><label htmlFor="base">Compare against</label>
      <select id="base" value={base} onChange={(e) => setBase(e.target.value)}>{(revs.data ?? []).filter((r) => r.id !== revision).map((r) => <option key={r.id} value={r.id}>{r.id} · {r.createdAt.slice(0, 16).replace("T", " ")} · {r.files} files</option>)}</select>
      <button disabled={!base || c.busy} onClick={() => void c.run("C23", "compare", { base, head: revision })}>Compare</button></div>
    {revs.data && revs.data.length < 2 && <p className="muted">Only one revision is indexed. Change something and re-index to compare.</p>}
    <Status error={c.error ?? arch.error} busy={c.busy || arch.busy} />
    {c.data && <>
      <p>{c.data.textDiff.symbolsTouched} symbol(s) touched in {c.data.textDiff.filesChanged} file(s).</p>
      <h3>What is different <small className="muted">({c.data.consequences.length})</small></h3>
      <ul>{c.data.consequences.map((x) => <li key={x.id}><Badge kind={x.kind === "TRANSACTION_BYPASS" || x.kind === "TESTS_LOST" || x.kind === "NEW_CYCLE" ? "warn" : "inference"}>{x.kind.replace(/_/g, " ").toLowerCase()}</Badge> {x.text}</li>)}</ul>
      <h3>Blast radius</h3>
      <table className="gates"><tbody>{c.data.blastRadius.map((b) => <tr key={b.entityId}><th scope="row">{b.entityId.replace(/^.*#/, "")}</th><td>{b.dependents} dependent(s)</td><td>{b.files.join(", ") || "—"}</td></tr>)}</tbody></table>
      {c.data.testImpact.length > 0 && <><h3>Tests</h3><ul>{c.data.testImpact.map((t) => <li key={t.entityId}><strong>{t.entityId.replace(/^.*#/, "")}</strong>: {t.lost.length ? `no longer reached by ${t.lost.join(", ")}` : ""} {t.gained.length ? `now reached by ${t.gained.join(", ")}` : ""}</li>)}</ul></>}
    </>}
    <h3>Why is it this way? (archaeology)</h3>
    <div className="row"><label htmlFor="ent">Element</label><select id="ent" value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">choose…</option>{nodes.map((n) => <option key={n.id} value={n.entityRefs[0]}>{n.label}</option>)}</select>
      <label htmlFor="since">Since</label><input id="since" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      <button disabled={!entity} onClick={() => void arch.run("C23", "archaeology", { revision, entityId: entity, window: from ? { from: `${from}T00:00:00Z` } : undefined })}>Show history</button></div>
    {nodes.length === 0 && <p className="muted small">Ask a question first so there are elements to choose from.</p>}
    {arch.data && <>
      <ul>{arch.data.chronology.map((x: any) => <li key={x.hash}><code>{x.hash}</code> {x.date.slice(0, 10)} · {x.author} — “{x.subject}”</li>)}</ul>
      {arch.data.fromForge?.map((x: any) => <p key={x.ref} className="small"><Badge kind="inference">untrusted text</Badge> {x.ref} “{x.title}” by {x.author} ({x.state})</p>)}
      {arch.data.gaps.map((g: any) => <p key={g.ref} className="warn-text small">{g.gap}</p>)}
      <p className="muted small">{arch.data.order}. Narrative claims below are inferences.</p>
      <ul>{arch.data.narrative.map((n: any) => <li key={n.draft.id}><Badge kind="inference">inference</Badge> {n.draft.assertion}</li>)}</ul>
    </>}
  </>;
}

// ---------------------------------------------------------------- C24
const SAMPLE = (rev: string) => JSON.stringify({ id: "env-1", sourceId: "api", deploymentId: "dep-1", codeRevision: rev, window: { from: Date.now() - 600000, to: Date.now() }, backendHandle: "tempo://tenant/api", signalKind: "trace", samplingRate: 1, spans: [{ traceId: "t1", spanId: "s1", name: "handler", startMs: Date.now() - 5000, endMs: Date.now() - 4980, file: "src/payments/fraud.ts", line: 5, fn: "checkFraud", error: false }] }, null, 2);
function Runtime({ revision }: { revision: string }) {
  const r = useCall<any>();
  const [text, setText] = useState(SAMPLE(revision));
  const [marker, setMarker] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setErr(null); let env: any; try { env = JSON.parse(text); } catch { setErr("That is not valid JSON."); return; }
    if (marker && env.deploymentId && env.codeRevision) await call("C24", "recordMarker", { sourceId: env.sourceId, deploymentId: env.deploymentId, revision: env.codeRevision, at: 0 }, key());
    const ing = await call<any>("C24", "ingest", { envelope: env }, key());
    if (!ing.ok) { setErr(ing.error.message + (ing.error.retryable ? " (you can retry later)" : "")); return; }
    await r.run("C24", "attribute", { envelopeId: env.id, revision });
  };
  const a = r.data;
  return <>
    <p className="notice">Runtime signals are joined to code with a stated exactness. A join is exact only when the revision, a deployment marker and a code location agree; anything else says why, and what cannot be tied to code is fog, not a guess. Raw volume stays in your telemetry backend.</p>
    <label htmlFor="env">Runtime envelope (JSON)</label>
    <textarea id="env" rows={9} className="mono" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
    <div className="row"><label><input type="checkbox" checked={marker} onChange={(e) => setMarker(e.target.checked)} /> Record the deployment marker (deployment → this revision)</label><button onClick={() => void go()} disabled={r.busy}>Ingest and attribute</button></div>
    <Status error={err ?? r.error} busy={r.busy} warnings={r.warnings} />
    {a && <>
      <p><Badge kind={a.exact ? "fact" : "hyp"}>{a.exact ? "exact" : "not exact"}</Badge><Badge>{a.method.replace(/_/g, " ").toLowerCase()}</Badge>{a.samplingRate && <Badge kind="hyp">sampled at {a.samplingRate}</Badge>}</p>
      {a.uncertaintyReason && <p className="counter"><strong>Why not exact:</strong> {a.uncertaintyReason}</p>}
      <table className="gates"><thead><tr><th scope="col">Code</th><th scope="col">Spans</th><th scope="col">Errors</th><th scope="col">p95 ms</th><th scope="col">Join</th></tr></thead><tbody>{a.perEntity.map((p: any) => <tr key={p.entityId}><th scope="row">{p.entityId.replace(/^.*#/, "")}</th><td>{p.spans}{p.estimatedSpans ? ` (≈${p.estimatedSpans})` : ""}</td><td>{p.errors}</td><td>{p.p95Ms ?? "—"}</td><td>{p.exact ? "exact" : p.method.replace(/_/g, " ").toLowerCase()}</td></tr>)}</tbody></table>
      <p><strong>Fog:</strong> {a.fog.spans} span(s) not tied to code{a.fog.reasons.length ? ` — ${a.fog.reasons.join("; ")}` : ""}.</p>
      <p className="muted small">Quality: {a.quality.length ? a.quality.join(", ") : "no issues noted"} · {a.counted.valid} valid, {a.counted.invalid} with impossible timestamps (excluded).</p>
    </>}
  </>;
}

// ---------------------------------------------------------------- C04
function Sources({ revision }: { revision: string }) {
  const s = useCall<{ sourceId: string; state: string; lastOk: string | null; lastError: string | null; resumeAt: string | null }[]>();
  const st = useCall<{ revision: { repoRoot: string } | null }>();
  const ingest = useCall<any>();
  const load = useCallback(async () => { await s.run("C04", "listSources", {}); await st.run("C01", "status", { revision }); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void load();
    // Sources can be registered automatically by indexing in the background;
    // refresh the list lightly while this panel is open.
    const t = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(t);
  }, [load]);
  const repoRoot = st.data?.revision?.repoRoot;
  const doIngest = async (sourceId: string) => {
    if (!repoRoot) return;
    await ingest.run("C04", "ingestGhSource", { repoRoot });
    await load();
  };
  return <>
    <p className="notice">External sources (a forge's pull requests, reviews) are read by the server. Credentials never enter the browser. Records that fail validation are set aside, so a source can be <em>partial</em>; an expired credential or a rate limit is shown as such, not retried in a loop. If the repository has a GitHub <code>origin</code> remote and the <code>gh</code> CLI is authenticated, a source is registered automatically when the repository is indexed; fetching pull requests from GitHub still requires clicking the button, because it consumes API quota.</p>
    <Status error={s.error ?? st.error ?? ingest.error} busy={s.busy || st.busy || ingest.busy} />
    {s.data?.length === 0 && <p className="muted">No external source is connected yet. If you index a GitHub repository while <code>gh</code> is authenticated, its source will appear here automatically.</p>}
    <ul className="cards">{(s.data ?? []).map((x) => <li key={x.sourceId} className="card"><strong>{x.sourceId}</strong> <Badge kind={statusKind(x.state)}>{x.state.replace(/_/g, " ").toLowerCase()}</Badge>
      <p className="muted small">{x.lastOk ? `Last good read ${x.lastOk.slice(0, 16).replace("T", " ")}.` : "Never read successfully."} {x.resumeAt ? `Resumes after ${x.resumeAt.slice(0, 16).replace("T", " ")}.` : ""}</p>
      {x.lastError && <p className="warn-text small">{x.lastError}</p>}
      {x.sourceId.startsWith("gh:") && repoRoot && <div className="row"><button className="secondary small" disabled={ingest.busy} onClick={() => void doIngest(x.sourceId)}>Fetch pull requests</button></div>}
    </li>)}</ul>
  </>;
}

// ---------------------------------------------------------------- C29
function Team({ revision, view }: { revision: string; view: ViewSpec | null }) {
  const me = useCall<{ principal: string; tenant: string }>(); const people = useCall<string[]>(); const ws = useCall<{ id: string; name: string; role: string }[]>();
  const shares = useCall<{ shares: { principal: string; role: string }[]; history: { kind: string; actor: string; detail: any }[] }>(); const read = useCall<any>(); const concepts = useCall<{ concepts: any[]; withheld: number }>();
  const [name, setName] = useState("new person"); const [sel, setSel] = useState(""); const [who, setWho] = useState(""); const [role, setRole] = useState("viewer");
  const [msg, setMsg] = useState<string | null>(null); const [deny, setDeny] = useState("");
  const refresh = useCallback(async () => { await me.run("C29", "whoami"); await people.run("C29", "people"); await ws.run("C29", "workspaces"); await concepts.run("C29", "conceptsFor", { revision }); }, [revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [refresh]);
  const enable = async () => { const m = await call<{ principal: string }>("C29", "whoami"); if (!m.ok) return; await call("C29", "addPrincipal", { principal: m.value.principal }, key()); await call("C29", "setAccess", { principal: m.value.principal, revision, allowed: true }, key()); setMsg("Team features are on for you."); await refresh(); };
  const addPerson = async () => { const r = await call("C29", "addPrincipal", { principal: name }, key()); setMsg(r.ok ? `${name} added. They have no access to any code until you grant it.` : r.error.message); await refresh(); };
  const grant = async (p: string, allowed: boolean, denied: string[] = []) => { const r = await call("C29", "setAccess", { principal: p, revision, allowed, deniedPrefixes: denied }, key()); setMsg(r.ok ? `${p}: ${allowed ? `can read this repository${denied.length ? ` except ${denied.join(", ")}` : ""}` : "no access"}` : r.error.message); };
  const makeShared = async () => { const c = await call<{ id: string }>("C29", "create", { name: view?.question?.slice(0, 80) || "Shared investigation", revision }, key()); if (!c.ok) { setMsg(c.error.message); return; } if (view) await call("C29", "applyOperation", { workspaceId: c.value.id, event: { kind: "SET_VIEW", view }, expectedVersion: 0 }, key()); setSel(c.value.id); await refresh(); };
  useEffect(() => { if (sel) void shares.run("C29", "shares", { workspaceId: sel }); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const doShare = async () => { const r = await call("C29", "share", { workspaceId: sel, principalId: who, role }, key()); setMsg(r.ok ? `Shared with ${who} as ${role}.` : r.error.message); await shares.run("C29", "shares", { workspaceId: sel }); };
  const handover = async () => { const cur = await call<any>("C29", "read", { workspaceId: sel }); if (!cur.ok) { setMsg(cur.error.message); return; } const r = await call<any>("C29", "handover", { workspaceId: sel, principalId: who, expectedVersion: cur.value.workspace.version }, key()); setMsg(r.ok ? `Handed over to ${who}. ${r.value.recipient.gaps.items ? `${r.value.recipient.gaps.items} item(s) are about code they cannot read and were not shown to them.` : "They can read everything in it."}` : r.error.message); await refresh(); await shares.run("C29", "shares", { workspaceId: sel }); };
  const confirm = async (c: any, verdict: "CONFIRM" | "REFUTE") => { const r = await call<any>("C29", "confirmSharedConcept", { conceptId: c.id, verdict, explanation: verdict === "CONFIRM" ? "confirmed by the team" : "corrected by the team", expectedVersion: 0 }, key()); if (!r.ok && r.error.code === "VERSION_CONFLICT") { const cv = (r.error as any).currentVersion; const r2 = await call<any>("C29", "confirmSharedConcept", { conceptId: c.id, verdict, explanation: verdict === "CONFIRM" ? "confirmed by the team" : "corrected by the team", expectedVersion: cv }, key()); setMsg(r2.ok ? `Concept ${r2.value.state.toLowerCase()}.` : r2.error.message); } else setMsg(r.ok ? `Concept ${r.value.state.toLowerCase()}.` : r.error.message); await concepts.run("C29", "conceptsFor", { revision }); };
  const peopleOther = (people.data ?? []).filter((p) => p !== me.data?.principal);
  return <>
    <p className="notice">Sharing never grants access to code. Someone can be given an investigation only if they can already read what it is about, and they see it cut down to what they may read. You are <strong>{me.data?.principal ?? "…"}</strong>{me.data ? ` in ${me.data.tenant}` : ""}.</p>
    <Status error={me.error ?? people.error ?? ws.error ?? shares.error ?? read.error} busy={me.busy || people.busy} />
    {msg && <p role="status" className="small">{msg}</p>}
    <section><h3>People and access</h3>
      <div className="row"><button onClick={() => void enable()} className="secondary">Turn on team features for me</button><label htmlFor="pname" className="sr">New person</label><input id="pname" value={name} onChange={(e) => setName(e.target.value)} /><button onClick={() => void addPerson()} className="secondary">Add person</button><label htmlFor="deny" className="sr">Folders to hide, comma separated</label><input id="deny" value={deny} onChange={(e) => setDeny(e.target.value)} placeholder="folders to hide, e.g. src/ledger" /></div>
      <ul>{(people.data ?? []).map((p) => <li key={p}>{p}{p !== me.data?.principal && <span className="row"> <button className="secondary small" onClick={() => void grant(p, true)}>Can read this repository</button><button className="secondary small" onClick={() => void grant(p, true, deny.split(",").map((x) => x.trim()).filter(Boolean))} disabled={!deny.trim()}>Can read, except the folders on the right</button><button className="secondary small" onClick={() => void grant(p, false)}>No access</button></span>}</li>)}</ul>
    </section>
    <section><h3>Shared investigations</h3>
      <div className="row"><button onClick={() => void makeShared()} disabled={!view}>Share the current map as a new investigation</button><label htmlFor="wssel" className="sr">Investigation</label>
        <select id="wssel" value={sel} onChange={(e) => setSel(e.target.value)}><option value="">choose…</option>{(ws.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name} ({w.role})</option>)}</select></div>
      {sel && <>
        <div className="row"><label htmlFor="who">With</label><select id="who" value={who} onChange={(e) => setWho(e.target.value)}><option value="">choose…</option>{peopleOther.map((p) => <option key={p}>{p}</option>)}</select>
          <label htmlFor="role">as</label><select id="role" value={role} onChange={(e) => setRole(e.target.value)}><option>viewer</option><option>editor</option></select>
          <button disabled={!who} onClick={() => void doShare()}>Share</button><button className="secondary" disabled={!who} onClick={() => void handover()}>Hand over ownership</button></div>
        <ul>{(shares.data?.shares ?? []).map((s) => <li key={s.principal}>{s.principal} — {s.role}</li>)}</ul>
        <details><summary>Operation history</summary><ul>{(shares.data?.history ?? []).map((h, i) => <li key={i}><code>{h.kind}</code> by {h.actor} {JSON.stringify(h.detail)}</li>)}</ul></details>
      </>}
    </section>
    <section><h3>Team concepts <small className="muted">({concepts.data?.concepts.length ?? 0} visible to you{concepts.data?.withheld ? `, ${concepts.data.withheld} withheld` : ""})</small></h3>
      <p className="muted small">Confirming or correcting a concept is attributed to you and reaches everyone who can see it. A confirmation is a judgment, never proof.</p>
      <ul className="cards">{(concepts.data?.concepts ?? []).slice(0, 12).map((c) => <li key={c.id} className="card"><strong>{c.title}</strong> <Badge>{c.kind}</Badge><Badge kind={statusKind(c.state)}>{c.state.toLowerCase()}</Badge>
        {(c.confirmedBy.length > 0 || c.refutedBy.length > 0) && <p className="muted small">{c.confirmedBy.length ? `Confirmed by ${c.confirmedBy.join(", ")}. ` : ""}{c.refutedBy.length ? `Corrected by ${c.refutedBy.join(", ")}.` : ""}</p>}
        <div className="row"><button className="secondary small" onClick={() => void confirm(c, "CONFIRM")}>Confirm</button><button className="secondary small" onClick={() => void confirm(c, "REFUTE")}>Correct</button></div></li>)}</ul>
    </section>
  </>;
}

// ---------------------------------------------------------------- C17
function Evaluation() {
  const st = useCall<any>(); const runs = useCall<any[]>(); const run = useCall<any>();
  const load = useCallback(async () => { await st.run("C17", "status"); await runs.run("C17", "runs", {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);
  const go = async (suite: string) => { await run.run("C17", "runSuite", { suite }, true); await load(); };
  return <>
    <p className="notice">Measured against things whose answer is known, with an interval on every number. A model that has not been measured is not trusted, and labels made by a script are never counted as expert labels.</p>
    <Status error={st.error ?? run.error} busy={st.busy || run.busy} />
    {st.data && <>
      <h3>Model in use: <code>{st.data.model.name}/{st.data.model.model}</code></h3>
      <table className="gates"><tbody>{st.data.suites.map((s: any) => <tr key={s.suite}><th scope="row">{s.suite}</th><td><Badge kind={statusKind(s.status)}>{s.status.replace(/_/g, " ").toLowerCase()}</Badge></td><td>{s.note}</td><td><button className="secondary small" disabled={run.busy} onClick={() => void go(s.suite)}>Run now</button></td></tr>)}</tbody></table>
      <h3>Labels</h3>
      <p>{st.data.experts.realLabels} real label(s) from {st.data.experts.experts} labeler(s); {st.data.experts.syntheticLabels} synthetic. <Badge kind={st.data.experts.expertValidated ? "fact" : "warn"}>{st.data.experts.expertValidated ? "expert-validated" : "not expert-validated"}</Badge></p>
      {st.data.experts.note && <p className="muted small">{st.data.experts.note}</p>}
      <h3>Calibration</h3>
      {st.data.calibration.note ? <p className="muted">{st.data.calibration.note}</p> : <table className="gates"><thead><tr><th scope="col">Stated</th><th scope="col">n</th><th scope="col">Observed (interval)</th><th scope="col">Verdict</th></tr></thead><tbody>{st.data.calibration.bins.map((b: any) => <tr key={b.range[0]}><th scope="row">{Math.round(b.range[0] * 100)}–{Math.round(b.range[1] * 100)}%</th><td>{b.n}</td><td>{b.observed === null ? "—" : `${Math.round(b.observed * 100)}% (${Math.round(b.lower * 100)}–${Math.round(b.upper * 100)}%)`}</td><td>{b.verdict.replace(/_/g, " ").toLowerCase()}</td></tr>)}</tbody></table>}
    </>}
    <h3>Runs</h3>
    {(runs.data ?? []).length === 0 && <p className="muted">No suite has been run yet.</p>}
    <ul className="cards">{(runs.data ?? []).map((r) => <li key={r.id} className="card"><strong>{r.suite}</strong> v{r.suiteVersion} <code>{r.model}</code> <span className="muted small">{r.at.slice(0, 16).replace("T", " ")}</span>
      <p className="small">Precision {pct(r.metrics.precision)} · Recall {pct(r.metrics.recall)} · Accuracy {pct(r.metrics.accuracy)}</p>
      {r.misses.length > 0 && <p className="warn-text small">Wrong on: {r.misses.join(", ")}</p>}</li>)}</ul>
  </>;
}
