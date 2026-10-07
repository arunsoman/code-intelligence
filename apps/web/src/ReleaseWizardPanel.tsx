import { useEffect, useRef, useState } from "react";
import { call } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { FormField } from "./FormField.tsx";
import { InfoTip } from "./InfoTip.tsx";

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
type ReleaseScopeIssue = { number: number; title: string; state: "open" | "closed" };

/**
 * "Release" panel (release-scope engine, C32). Create → Scope (a non-committing preview of the GitHub
 * milestone) → Freeze. This is the scope the evidence ledger reads from — freezing doesn't guess: an issue
 * that lands in the milestone after freeze shows up as NEEDS_ASSESSMENT on the next freeze, never silently
 * in scope, until a human explicitly includes it (mirrors F08's campaign-population rule).
 */
export function ReleaseWizardPanel({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Release[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [view, setView] = useState<ReleaseView | null>(null);
  const [preview, setPreview] = useState<ReleaseScopeIssue[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [milestoneRepo, setMilestoneRepo] = useState("");
  const [milestoneNumber, setMilestoneNumber] = useState("");
  const [touched, setTouched] = useState(false);

  const live = useRef(true);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const wrap = async (label: string, fn: () => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>, next?: (v: unknown) => void) => {
    setBusy(label); setError(null); setNotice(null);
    const r = await fn();
    if (!live.current) return;
    setBusy(null);
    if (!r.ok) { setError(r.error?.message ?? "failed"); return; }
    next?.(r.value);
  };

  const loadList = async () => {
    const r = await call<Release[]>("C32", "listReleases", {});
    if (!live.current) return;
    if (r.ok) { setList(r.value); if (!id && r.value.length) setId(r.value[0]!.releaseId); } else setError(r.error.message);
  };
  useEffect(() => { void loadList(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async (releaseId = id) => {
    if (!releaseId) return;
    const r = await call<ReleaseView>("C32", "getRelease", { releaseId });
    if (!live.current) return;
    if (r.ok) setView(r.value); else setError(r.error.message);
  };
  useEffect(() => { setPreview(null); void refresh(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = () => {
    setTouched(true);
    const [owner, repo] = milestoneRepo.split("/").map((s) => s.trim());
    const number = Number(milestoneNumber);
    if (!name.trim() || !tag.trim() || !owner || !repo || !Number.isFinite(number) || number <= 0) return;
    void wrap("create", () => call("C32", "createRelease", { spec: { name: name.trim(), tag: tag.trim(), milestone: { host: "github.com", owner, repo, number } } }, crypto.randomUUID()), async (v) => {
      const r = v as Release;
      setId(r.releaseId);
      await loadList();
      setNotice("Release created in DRAFT. Preview the milestone, then freeze its scope.");
      setName(""); setTag(""); setMilestoneRepo(""); setMilestoneNumber(""); setTouched(false);
    });
  };

  const previewMilestone = () => {
    if (!id) return;
    void wrap("preview", () => call("C32", "previewMilestone", { releaseId: id }), (v) => setPreview((v as { issues: ReleaseScopeIssue[] }).issues));
  };

  const freeze = () => {
    if (!id || !view) return;
    void wrap("freeze", () => call("C32", "freezeScope", { releaseId: id, expectedVersion: view.release.version }, crypto.randomUUID()), async () => {
      setPreview(null);
      setNotice("Scope frozen. Anything that lands in the milestone later needs assessment before it counts.");
      await refresh(); await loadList();
    });
  };

  const assess = (issueNumber: number) => {
    if (!id) return;
    void wrap(`assess-${issueNumber}`, () => call("C32", "assessReleaseItem", { releaseId: id, issueNumber }, crypto.randomUUID()), async () => {
      setNotice(`#${issueNumber} included in scope.`);
      await refresh();
    });
  };

  const hasEmptyList = list.length === 0;

  return (
    <Modal title="Releases" onClose={onClose} className="wide tall" initialFocusRef={firstFieldRef}>
      <p className="muted small">
        What's actually in a release, frozen against a GitHub milestone.{" "}
        <InfoTip label="What is a release's scope?">
          Freezing pulls every issue currently in the milestone into scope. An issue that shows up in the milestone
          later needs an explicit assessment before it's counted — it is never folded in silently.
        </InfoTip>
      </p>

      {error && <p className="status-warn" role="alert">{error}</p>}
      {notice && <p className="status-ok" role="status">{notice}</p>}
      {busy && <p className="muted small" role="status">{busy}…</p>}

      <section aria-label="Releases you can see">
        <h3>Releases</h3>
        {hasEmptyList ? (
          <div className="empty-state">
            <span className="empty-state__icon" aria-hidden="true">🚀</span>
            <p>No releases yet.</p>
            <button className="secondary" onClick={() => firstFieldRef.current?.focus()}>Create your first release</button>
          </div>
        ) : (
          <ul className="dirs" aria-label="Release list" style={{ minHeight: 80 }}>
            {list.map((r) => (
              <li key={r.releaseId} className={r.releaseId === id ? "active" : undefined} style={{ cursor: "pointer" }} onClick={() => setId(r.releaseId)}>
                <strong>{r.name}</strong> <span className="mono muted small">{r.tag}</span>{" "}
                <span className="chip">{r.state}</span>{" "}
                <span className="chip muted">scope v{r.version}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Create a release">
        <h3>New release</h3>
        <fieldset className="form-fieldset">
          <legend>Identity</legend>
          <div className="form-grid">
            <FormField label="Release name" htmlFor="release-name" required error={touched && !name.trim() ? "A release needs a name." : null} helper="A short name for this release.">
              <input id="release-name" ref={firstFieldRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. v2.5.0" aria-required="true" />
            </FormField>
            <FormField label="Tag" htmlFor="release-tag" required error={touched && !tag.trim() ? "A release needs a tag." : null} helper="The git tag this release will publish as.">
              <input id="release-tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. v2.5.0" aria-required="true" />
            </FormField>
          </div>
        </fieldset>

        <fieldset className="form-fieldset">
          <legend>GitHub milestone</legend>
          <div className="form-grid">
            <FormField label="Repository" htmlFor="release-repo" required error={touched && !milestoneRepo.includes("/") ? "owner/repo, e.g. acme/widgets." : null} helper="owner/repo on github.com.">
              <input id="release-repo" value={milestoneRepo} onChange={(e) => setMilestoneRepo(e.target.value)} placeholder="acme/widgets" aria-required="true" />
            </FormField>
            <FormField label="Milestone number" htmlFor="release-milestone" required error={touched && !milestoneNumber ? "The milestone's number." : null} helper="The milestone's issues become the starting scope.">
              <input id="release-milestone" type="number" min={1} value={milestoneNumber} onChange={(e) => setMilestoneNumber(e.target.value)} placeholder="7" aria-required="true" />
            </FormField>
          </div>
        </fieldset>

        <div className="modal-actions" style={{ borderTop: "none", paddingTop: 4, justifyContent: "flex-end" }}>
          <button className="primary" onClick={create} disabled={busy !== null} aria-busy={busy === "create"}>
            {busy === "create" && <span className="spinner" aria-hidden="true" />}Create
          </button>
        </div>
      </section>

      {view && (
        <section aria-label="Release detail">
          <h3>{view.release.name} <span className="chip">{view.release.state}</span></h3>
          <p className="muted small">
            Milestone <code>{view.release.milestone.owner}/{view.release.milestone.repo}#{view.release.milestone.number}</code>
            {view.scope && <> · scope v{view.scope.version}, frozen {new Date(view.scope.frozenAt).toLocaleString()}</>}
          </p>

          {view.release.state === "DRAFT" && (
            <div className="form-fieldset">
              <legend>Scope (preview — nothing is committed yet)</legend>
              <button className="secondary" onClick={previewMilestone} disabled={busy !== null}>Preview milestone</button>
              {preview && (
                <>
                  <ul className="dirs" aria-label="Milestone issues" style={{ minHeight: 60, marginTop: 8 }}>
                    {preview.map((i) => (
                      <li key={i.number}>#{i.number} {i.title} <span className="chip muted">{i.state}</span></li>
                    ))}
                  </ul>
                  <div className="modal-actions" style={{ borderTop: "none", paddingTop: 8, justifyContent: "flex-end" }}>
                    <button className="primary" onClick={freeze} disabled={busy !== null} aria-busy={busy === "freeze"}>
                      {busy === "freeze" && <span className="spinner" aria-hidden="true" />}Freeze scope v1 ({preview.length} issue{preview.length === 1 ? "" : "s"})
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {view.release.state === "SCOPE_FROZEN" && (
            <>
              <p className="muted small">
                <span className="chip">{view.counts.IN_SCOPE ?? 0} in scope</span>{" "}
                {view.counts.EXCLUDED ? <span className="chip muted">{view.counts.EXCLUDED} excluded</span> : null}{" "}
                {view.needsAssessment > 0 && <span className="chip incomplete">{view.needsAssessment} needs assessment</span>}
              </p>
              <ul className="dirs" aria-label="Release items" style={{ minHeight: 80 }}>
                {view.items.map((it) => (
                  <li key={it.issueNumber}>
                    #{it.issueNumber} {it.title}{" "}
                    <span className="chip">{it.state}</span>{" "}
                    {it.assessmentState === "NEEDS_ASSESSMENT" && <span className="chip incomplete">needs assessment</span>}
                    {it.reason && <span className="muted small"> — {it.reason}</span>}
                    {it.assessmentState === "NEEDS_ASSESSMENT" && (
                      <button className="secondary small" style={{ marginLeft: 8 }} onClick={() => assess(it.issueNumber)} disabled={busy !== null}>Include in scope</button>
                    )}
                  </li>
                ))}
              </ul>
              <div className="modal-actions" style={{ borderTop: "none", paddingTop: 8, justifyContent: "flex-end" }}>
                <button className="secondary" onClick={freeze} disabled={busy !== null} aria-busy={busy === "freeze"} title="Re-read the milestone; a new issue is flagged, not silently added">
                  {busy === "freeze" && <span className="spinner" aria-hidden="true" />}Re-check milestone (scope v{view.release.version + 1})
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </Modal>
  );
}
