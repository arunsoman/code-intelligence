import { useEffect, useRef, useState } from "react";
import { call } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { FormField } from "./FormField.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { freezeSelection, parseRepo, scopeCounts } from "./release-form.ts";

/** Mirrors the shapes in packages/schema/src/index.ts's "Release scope" section. */
type ReleaseMilestoneRef = { host: string; owner: string; repo: string; number: number };
type Release = {
  releaseId: string; tenantId: string; name: string; tag: string;
  milestone: ReleaseMilestoneRef; state: "DRAFT" | "SCOPE_FROZEN" | "CANCELLED"; version: number;
  createdBy: string; createdAt: string; updatedAt: string;
};
type ReleaseItemView = {
  issueNumber: number; title: string; issueState: "open" | "closed";
  state: "IN_SCOPE" | "EXCLUDED"; assessmentState: "ASSESSED" | "NEEDS_ASSESSMENT"; reason?: string;
};
type ReleaseView = {
  release: Release;
  scope: { version: number; scopeHash: string; frozenAt: string } | null;
  items: ReleaseItemView[];
  counts: Partial<Record<"IN_SCOPE" | "EXCLUDED", number>>;
  needsAssessment: number;
};
type MilestoneInfo = { number: number; title: string; state: "open" | "closed"; openIssues: number; closedIssues: number };
type ScopeIssue = { number: number; title: string; state: "open" | "closed" };
type Candidate = ScopeIssue & { included: boolean; manual?: boolean };

const STEPS = ["Create", "Scope", "Freeze"] as const;

/**
 * "Releases" wizard (release-scope engine, C32): Create → Scope → Freeze, then a frozen summary that hands off
 * to the Release Lens. The scope step shows the milestone's real issues so a human can leave stretch goals out
 * or add an issue by number; freezing commits exactly that list. An issue that lands in the milestone after
 * freeze is flagged NEEDS_ASSESSMENT, never silently in scope, until a human includes it.
 */
export function ReleaseWizardPanel({ onClose, onOpenLens }: { onClose: () => void; onOpenLens?: (releaseId: string) => void }) {
  const [list, setList] = useState<Release[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [view, setView] = useState<ReleaseView | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [repoText, setRepoText] = useState("");
  const [milestones, setMilestones] = useState<MilestoneInfo[] | null>(null);
  const [milestoneNumber, setMilestoneNumber] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [manualText, setManualText] = useState("");

  const live = useRef(true);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const repo = parseRepo(repoText);

  const wrap = async <T,>(label: string, fn: () => Promise<{ ok: boolean; value?: T; error?: { message: string } }>, next?: (v: T) => void | Promise<void>) => {
    setBusy(label); setError(null); setNotice(null);
    const r = await fn();
    if (!live.current) return;
    setBusy(null);
    if (!r.ok) { setError(r.error?.message ?? "failed"); return; }
    await next?.(r.value as T);
  };

  const loadList = async (selectFirst = false) => {
    const r = await call<Release[]>("C32", "listReleases", {});
    if (!live.current) return;
    if (r.ok) { setList(r.value); if (selectFirst && r.value.length) setId(r.value[0]!.releaseId); } else setError(r.error.message);
  };
  useEffect(() => { void loadList(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadPreview = async (releaseId: string) => {
    await wrap<{ issues: ScopeIssue[] }>("Reading the milestone", () => call("C32", "previewMilestone", { releaseId }), (v) => {
      setCandidates((prev) => {
        const manual = (prev ?? []).filter((c) => c.manual);
        const known = new Map((prev ?? []).map((c) => [c.number, c.included]));
        return [...v.issues.map((i) => ({ ...i, included: known.get(i.number) ?? true })), ...manual.filter((m) => !v.issues.some((i) => i.number === m.number))];
      });
    });
  };

  const refresh = async (releaseId: string | null = id) => {
    if (!releaseId) return;
    const r = await call<ReleaseView>("C32", "getRelease", { releaseId });
    if (!live.current) return;
    if (!r.ok) { setError(r.error.message); return; }
    setView(r.value);
  };

  // Choosing a release: a draft resumes at Scope, a frozen one shows its summary.
  useEffect(() => {
    setCandidates(null); setManualText("");
    if (!id) { setView(null); setStep(1); return; }
    void (async () => {
      const r = await call<ReleaseView>("C32", "getRelease", { releaseId: id });
      if (!live.current) return;
      if (!r.ok) { setError(r.error.message); return; }
      setView(r.value);
      if (r.value.release.state === "DRAFT") { setStep(2); void loadPreview(id); } else setStep(3);
    })();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMilestones = () => {
    if (!repo) return;
    setMilestones(null); setMilestoneNumber(null);
    void wrap<{ milestones: MilestoneInfo[] }>("Reading the repository's milestones", () => call("C32", "listMilestones", { owner: repo.owner, repo: repo.repo }), (v) => {
      setMilestones(v.milestones);
      const open = v.milestones.filter((m) => m.state === "open");
      if (open.length) setMilestoneNumber(open[0]!.number);
    });
  };

  const create = () => {
    setTouched(true);
    if (!name.trim() || !tag.trim() || !repo || !milestoneNumber) return;
    void wrap<Release>("Creating", () => call("C32", "createRelease", { spec: { name: name.trim(), tag: tag.trim(), milestone: { host: "github.com", owner: repo.owner, repo: repo.repo, number: milestoneNumber } } }, crypto.randomUUID()), async (r) => {
      await loadList();
      setName(""); setTag(""); setRepoText(""); setMilestones(null); setMilestoneNumber(null); setTouched(false);
      setId(r.releaseId);
      setNotice("Draft created. Choose what goes in scope.");
    });
  };

  const toggle = (n: number) => setCandidates((cs) => cs?.map((c) => (c.number === n ? { ...c, included: !c.included } : c)) ?? cs);

  const addManual = () => {
    const n = Number(manualText.replace(/^#/, ""));
    if (!id || !Number.isInteger(n) || n <= 0) { setError("Enter an issue number, e.g. 249."); return; }
    if (candidates?.some((c) => c.number === n)) { setError(`#${n} is already in the list.`); return; }
    void wrap<ScopeIssue>("Looking the issue up", () => call("C32", "lookupIssue", { releaseId: id, number: n }), (issue) => {
      setCandidates((cs) => [...(cs ?? []), { ...issue, included: true, manual: true }]);
      setManualText("");
    });
  };

  const freeze = (withSelection: boolean) => {
    if (!id || !view) return;
    const selection = withSelection && candidates ? freezeSelection(candidates) : undefined;
    void wrap("Freezing", () => call("C32", "freezeScope", { releaseId: id, expectedVersion: view.release.version, selection }, crypto.randomUUID()), async () => {
      setCandidates(null);
      await refresh(); await loadList();
      setNotice(withSelection ? "Scope frozen." : "Milestone re-read. Anything new needs your assessment below.");
    });
  };

  const assess = (issueNumber: number) => {
    if (!id) return;
    void wrap(`Including #${issueNumber}`, () => call("C32", "assessReleaseItem", { releaseId: id, issueNumber }, crypto.randomUUID()), async () => {
      setNotice(`#${issueNumber} included in scope.`);
      await refresh();
    });
  };

  const frozen = view?.release.state === "SCOPE_FROZEN";
  const counts = scopeCounts(candidates ?? []);
  const maxReached = !id ? 1 : frozen ? 3 : step;
  const open = milestones?.filter((m) => m.state === "open") ?? [];
  const noMilestones = milestones !== null && milestones.length === 0;

  return (
    <Modal title="Releases" onClose={onClose} className="wide tall" initialFocusRef={firstFieldRef}>
      <p className="muted small">
        What's actually in a release, frozen against a GitHub milestone.{" "}
        <InfoTip label="What is a release's scope?">
          Freezing commits the issues you chose. An issue that shows up in the milestone later needs an explicit
          assessment before it's counted — it is never folded in silently.
        </InfoTip>
      </p>

      <div className="rw-pick">
        <label className="form-field" style={{ flex: 1 }}>
          <span className="form-label">Release</span>
          <select value={id ?? ""} onChange={(e) => setId(e.target.value || null)} aria-label="Release">
            <option value="">+ New release</option>
            {list.map((r) => <option key={r.releaseId} value={r.releaseId}>{r.name} ({r.tag}) — {r.state === "SCOPE_FROZEN" ? `scope v${r.version - 1 || 1} frozen` : r.state.toLowerCase()}</option>)}
          </select>
        </label>
      </div>

      <ol className="rw-steps" aria-label="Progress">
        {STEPS.map((label, i) => {
          const n = (i + 1) as 1 | 2 | 3;
          const done = frozen ? true : n < step;
          const cls = n === step ? "current" : done ? "done" : "";
          return (
            <li key={label} className={`rw-step ${cls}`} aria-current={n === step ? "step" : undefined}>
              <button className="rw-step-btn" disabled={n > maxReached || (n === 1 && !!id) || (frozen && n < 3)} onClick={() => setStep(n)}>
                <span className="rw-num">{done && n !== step ? "✓" : n}</span> {label}
              </button>
            </li>
          );
        })}
      </ol>

      {error && <p className="status-warn" role="alert">{error}</p>}
      {notice && <p className="status-ok" role="status">{notice}</p>}
      {busy && <p className="muted small" role="status">{busy}…</p>}

      {step === 1 && !id && (
        <section className="rw-panel" aria-label="Create the release">
          <h3>Create the release</h3>
          <p className="muted small">Name it and point it at the GitHub milestone its scope will come from.</p>
          <div className="form-grid">
            <FormField label="Release name" htmlFor="release-name" required error={touched && !name.trim() ? "A release needs a name." : null}>
              <input id="release-name" ref={firstFieldRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. v2.5.0" aria-required="true" />
            </FormField>
            <FormField label="Tag" htmlFor="release-tag" required error={touched && !tag.trim() ? "A release needs a tag." : null} helper="The git tag this release will publish as.">
              <input id="release-tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. v2.5.0" aria-required="true" />
            </FormField>
          </div>
          <FormField label="Repository" htmlFor="release-repo" required
            error={(touched || repoText) && !repo ? "Use owner/repo, e.g. acme/widgets (a github.com URL works too)." : null}
            helper={repo ? <>Reading milestones of <code>{repo.owner}/{repo.repo}</code></> : "owner/repo on github.com."}>
            <input id="release-repo" value={repoText} onChange={(e) => { setRepoText(e.target.value); setMilestones(null); setMilestoneNumber(null); }} onBlur={() => { if (repo && milestones === null) loadMilestones(); }}
              placeholder="acme/widgets" aria-required="true" />
          </FormField>
          <FormField label="GitHub milestone" htmlFor="release-milestone" required
            error={touched && !milestoneNumber && !noMilestones ? "Choose the milestone this release is built from." : null}
            helper="Issues in this milestone become the starting scope on the next step.">
            <select id="release-milestone" value={milestoneNumber ?? ""} onChange={(e) => setMilestoneNumber(e.target.value ? Number(e.target.value) : null)} disabled={!milestones || milestones.length === 0} aria-required="true">
              <option value="">{!repo ? "Enter the repository first" : milestones === null ? "Loading milestones…" : noMilestones ? "No milestones" : "Choose a milestone"}</option>
              {milestones?.map((m) => (
                <option key={m.number} value={m.number}>{m.title} — {m.openIssues + m.closedIssues} issue{m.openIssues + m.closedIssues === 1 ? "" : "s"}{m.state === "closed" ? " (closed)" : ""}</option>
              ))}
            </select>
          </FormField>
          {noMilestones && repo && (
            <p className="status-warn" role="status">
              <code>{repo.owner}/{repo.repo}</code> has no milestones. Create one on GitHub and assign issues to it:{" "}
              <a href={`https://github.com/${repo.owner}/${repo.repo}/milestones`} target="_blank" rel="noreferrer">open its milestones</a>, then{" "}
              <button className="link" onClick={loadMilestones}>check again</button>.
            </p>
          )}
          {open.length === 0 && milestones && milestones.length > 0 && <p className="muted small">Every milestone here is closed; a closed one can still be chosen.</p>}
          <div className="modal-actions">
            <button className="primary" onClick={create} disabled={busy !== null} aria-busy={busy === "Creating"}>Create draft release →</button>
          </div>
        </section>
      )}

      {step === 2 && view && !frozen && (
        <section className="rw-panel" aria-label="Scope the release">
          <h3>Scope the release</h3>
          <p className="muted small">
            Pulled from milestone <code>{view.release.milestone.owner}/{view.release.milestone.repo}#{view.release.milestone.number}</code>. Untick a stretch goal, or add an issue by number from elsewhere. Nothing is committed until you freeze.
          </p>
          {candidates && candidates.length === 0 && !busy && !error && (
            <p className="status-warn" role="status">The milestone has no issues yet. Assign issues to it on GitHub, then <button className="link" onClick={() => void loadPreview(id!)}>re-read it</button>.</p>
          )}
          {candidates && candidates.length > 0 && (
            <>
              <p className="rw-counts"><span><b>{counts.committed}</b> committed</span> <span><b>{counts.stretch}</b> stretch / excluded</span> <span><b>{counts.total}</b> total</span></p>
              <ul className="rw-issues" aria-label="Milestone issues">
                {candidates.map((c) => (
                  <li key={c.number} className={c.included ? undefined : "excluded"}>
                    <label>
                      <input type="checkbox" checked={c.included} onChange={() => toggle(c.number)} />
                      <span className="mono rw-n">#{c.number}</span>
                      <span className="rw-title">{c.title}</span>
                      {c.manual && <span className="chip">added by number</span>}
                      <span className={`chip ${c.state === "open" ? "pass" : ""}`}>{c.state}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="rw-add">
            <input aria-label="Add issue by number" value={manualText} onChange={(e) => setManualText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addManual(); }} placeholder="Add issue by number, e.g. 249" />
            <button className="secondary" onClick={addManual} disabled={busy !== null}>Add to scope</button>
          </div>
          <div className="modal-actions">
            <button className="secondary" onClick={() => void loadPreview(id!)} disabled={busy !== null}>Re-read milestone</button>
            <span />
            <button className="primary" onClick={() => setStep(3)} disabled={busy !== null || counts.committed === 0} title={counts.committed === 0 ? "Tick at least one issue" : undefined}>Review &amp; freeze →</button>
          </div>
        </section>
      )}

      {step === 3 && view && !frozen && (
        <section className="rw-panel" aria-label="Freeze the scope">
          <h3>Freeze the scope</h3>
          <p className="muted small">This is the handoff: the evidence ledger and the Release Lens read against this exact list.</p>
          <dl className="rw-summary">
            <div><dt>Release</dt><dd>{view.release.name} ({view.release.tag})</dd></div>
            <div><dt>Milestone</dt><dd>{view.release.milestone.owner}/{view.release.milestone.repo}#{view.release.milestone.number}</dd></div>
            <div><dt>Issues frozen into scope</dt><dd>{counts.committed}</dd></div>
            <div><dt>Excluded / stretch</dt><dd>{counts.stretch}</dd></div>
            <div><dt>Scope version</dt><dd>v1</dd></div>
          </dl>
          <p className="rw-warning"><b>After freezing:</b> a new issue added to this milestone is flagged <code>needs assessment</code> instead of silently joining the release. Nothing is edited in place; re-checking the milestone starts the next scope version.</p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setStep(2)} disabled={busy !== null}>← Back</button>
            <span />
            <button className="primary" onClick={() => freeze(true)} disabled={busy !== null || counts.committed === 0} aria-busy={busy === "Freezing"}>
              {busy === "Freezing" && <span className="spinner" aria-hidden="true" />}Freeze scope v1
            </button>
          </div>
        </section>
      )}

      {step === 3 && view && frozen && (
        <section className="rw-panel" aria-label="Frozen scope">
          <p className="rw-frozen"><span className="rw-dot" aria-hidden="true" />Scope v{view.scope?.version} frozen</p>
          <p className="muted small">
            {view.release.name} ({view.release.tag}) · milestone <code>{view.release.milestone.owner}/{view.release.milestone.repo}#{view.release.milestone.number}</code>
            {view.scope && <> · frozen {new Date(view.scope.frozenAt).toLocaleString()}</>}
          </p>
          <dl className="rw-summary">
            <div><dt>Issues in scope</dt><dd>{view.counts.IN_SCOPE ?? 0}</dd></div>
            <div><dt>Excluded / stretch</dt><dd>{view.counts.EXCLUDED ?? 0}</dd></div>
            <div><dt>Scope version</dt><dd>v{view.scope?.version}</dd></div>
          </dl>
          {view.items.filter((i) => i.assessmentState === "NEEDS_ASSESSMENT").map((it) => (
            <div key={it.issueNumber} className="rw-drift" role="status">
              <b>#{it.issueNumber} {it.title} — added to the milestone after freeze</b>
              <p>Not part of scope v{view.scope?.version}. It stays out of every Release Lens row until you include it.</p>
              <button className="secondary" onClick={() => assess(it.issueNumber)} disabled={busy !== null}>Include in scope</button>
            </div>
          ))}
          <ul className="rw-issues" aria-label="Release items">
            {view.items.map((it) => (
              <li key={it.issueNumber} className={it.state === "EXCLUDED" ? "excluded" : undefined}>
                <span className="mono rw-n">#{it.issueNumber}</span>
                <span className="rw-title">{it.title}</span>
                <span className="chip">{it.state === "EXCLUDED" ? "excluded" : "in scope"}</span>
                <span className={`chip ${it.issueState === "open" ? "pass" : ""}`}>{it.issueState}</span>
                {it.reason && it.state === "EXCLUDED" && <span className="muted small">{it.reason}</span>}
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <button className="secondary" onClick={() => freeze(false)} disabled={busy !== null} aria-busy={busy === "Freezing"} title="Re-read the milestone; a new issue is flagged, not silently added">
              {busy === "Freezing" && <span className="spinner" aria-hidden="true" />}Re-check milestone
            </button>
            <span />
            {onOpenLens && <button className="primary" onClick={() => onOpenLens(view.release.releaseId)}>Open Release Lens →</button>}
          </div>
        </section>
      )}
    </Modal>
  );
}
