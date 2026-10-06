import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CampaignPlan, CampaignView, ChildCluster, ChildView, DryRunResult, PopulationDiff } from "@cie/schema";
import { call } from "./api.ts";
import { CAMPAIGN_COPY, countRows, compatibilityLabel, compatibilityTone, progressText, stateCell } from "./campaign-summary.ts";
import { Modal } from "./Modal.tsx";
import { FormField } from "./FormField.tsx";
import { ChipInput } from "./ChipInput.tsx";
import { InfoTip } from "./InfoTip.tsx";

/**
 * "Campaigns" panel (F08). Lists campaigns the viewer can see, shows the children table with per-state counts
 * (never a single health score), the tabular equivalent of the compatibility graph, the order-and-rollback section,
 * the batch timeline, the population-diff actions, the review queue with diff clusters, the dry-run preview, and the
 * explicit controls. A hidden remainder is never counted; every aggregate is computed by the server over the viewer's
 * visible children.
 */
type CampaignListItem = { campaignId: string; name: string; state: string; transformationHash: string; populationVersion: number | null; counts: Partial<Record<string, number>>; visibleChildren: number };
type CompatRow = CampaignPlan["compatibility"][number];
type ChildFilter = { state: string; failed: boolean; stale: boolean; needsAssessment: boolean; owner: string };

const uuid = () => crypto.randomUUID();
const toneChip = (tone: "ok" | "warn" | "bad" | "muted") => tone === "ok" ? "chip pass" : tone === "bad" ? "chip fail" : tone === "warn" ? "chip incomplete" : "chip muted";

const RECIPE_OPTIONS = [
  { value: "codemod", label: "Codemod" },
  { value: "migration", label: "Migration" },
  { value: "dep-upgrade", label: "Dependency upgrade" },
];

export function CampaignPanel({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<CampaignListItem[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [view, setView] = useState<CampaignView | null>(null);
  const [plan, setPlan] = useState<CampaignPlan | null>(null);
  const [children, setChildren] = useState<ChildView[]>([]);
  const [clusters, setClusters] = useState<ChildCluster[]>([]);
  const [unclustered, setUnclustered] = useState(0);
  const [diff, setDiff] = useState<PopulationDiff | null>(null);
  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [filter, setFilter] = useState<ChildFilter>({ state: "", failed: false, stale: false, needsAssessment: false, owner: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [recipeId, setRecipeId] = useState("codemod");
  const [recipeVersion, setRecipeVersion] = useState("");
  const [explicit, setExplicit] = useState<string[]>([]);
  const [canarySize, setCanarySize] = useState(1);
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [githubWrites, setGithubWrites] = useState(20);
  const [touched, setTouched] = useState(false);
  const [approveWhy, setApproveWhy] = useState("");

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
    const r = await call<CampaignListItem[]>("C28", "listCampaigns", {});
    if (!live.current) return;
    if (r.ok) { setList(r.value); if (!id && r.value.length) setId(r.value[0]!.campaignId); } else setError(r.error.message);
  };
  useEffect(() => { void loadList(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async (campaignId = id) => {
    if (!campaignId) return;
    const [v, p, c, cl] = await Promise.all([
      call<CampaignView>("C28", "getCampaign", { campaignId }),
      call<CampaignPlan>("C28", "getCampaignPlan", { campaignId }),
      call<{ children: ChildView[] }>("C28", "listChildren", { campaignId, limit: 50, ...(filter.state ? { filter: { state: filter.state } } : {}) }),
      call<{ clusters: ChildCluster[]; unclustered: number }>("C28", "clusterChildren", { campaignId }),
    ]);
    if (!live.current) return;
    if (v.ok) setView(v.value); else setError(v.error.message);
    if (p.ok) setPlan(p.value);
    if (c.ok) setChildren(c.value.children);
    if (cl.ok) { setClusters(cl.value.clusters); setUnclustered(cl.value.unclustered); }
  };
  useEffect(() => { void refresh(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const version = () => view?.campaign.version ?? 0;
  const act = (label: string, component: string, op: string, body: Record<string, unknown>, keyed = true) =>
    wrap(label, () => call(component, op, body, keyed ? uuid() : undefined), async () => { await refresh(); await loadList(); });

  const rowsToShow = (view?.children ?? children).filter((r) =>
    (!filter.state || r.state === filter.state) &&
    (!filter.failed || r.state === "FAILED" || r.state === "BLOCKED") &&
    (!filter.stale || r.stale) &&
    (!filter.needsAssessment || r.assessmentState === "NEEDS_ASSESSMENT") &&
    (!filter.owner || (r.author ?? "").includes(filter.owner)));

  const sel = list.find((c) => c.campaignId === id) ?? null;
  const compat: CompatRow[] = plan?.compatibility ?? [];

  const validateCreate = () => {
    setTouched(true);
    if (!name.trim()) return false;
    if (!recipeId.trim()) return false;
    if (!recipeVersion.trim()) return false;
    return true;
  };

  const create = () => {
    if (!validateCreate()) return;
    const spec = {
      name: name.trim(),
      selector: explicit.length ? { explicit } : { attributes: { language: "typescript" } },
      transformation: { kind: "RECIPE" as const, recipeId, recipeVersion, args: {} },
      compatibility: { policyId: "default", required: ["CANDIDATE_WITH_CANDIDATE" as const] },
      batches: { canarySize, maxConcurrent, pauseRules: [{ kind: "JOINT_FAILURE" as const }] },
      budgets: { wallMs: 3_600_000, githubWrites },
    };
    return wrap("create", () => call("C28", "createCampaign", { spec }, uuid()), async (v) => {
      const c = v as { campaignId: string };
      setId(c.campaignId);
      await loadList();
      setNotice("Campaign created in DRAFT. Freeze its population to continue.");
      setName(""); setRecipeVersion(""); setExplicit([]); setCanarySize(1); setMaxConcurrent(3); setGithubWrites(20); setTouched(false);
    });
  };

  const publishAll = async () => {
    if (!id) return;
    const targets = (view?.children ?? []).filter((r) => r.state === "REVIEW_READY").map((r) => r.repositoryId);
    for (const repositoryId of targets) await call("C30", "issuePublicationGrant", { campaignId: id, repositoryId }, uuid());
    await act("publish", "C30", "publishCampaignChildren", { campaignId: id, childRepositoryIds: targets, idempotencyKey: uuid() }, false);
  };

  const hasEmptyList = list.length === 0;

  return (
    <Modal title="Coordinated campaigns" onClose={onClose} className="wide tall" initialFocusRef={firstFieldRef}>
      <p className="muted small">
        Results are shown per repository.{" "}
        <InfoTip label="What is a campaign?">
          A campaign runs coordinated changes across multiple repositories. Each repository gets its own child campaign.
        </InfoTip>
      </p>

      {error && <p className="status-warn" role="alert">{error}</p>}
      {notice && <p className="status-ok" role="status">{notice}</p>}
      {busy && <p className="muted small" role="status">{busy}…</p>}

      <section aria-label="Campaigns you can see">
        <h3>Campaigns</h3>
        {hasEmptyList ? (
          <div className="empty-state">
            <span className="empty-state__icon" aria-hidden="true">📋</span>
            <p>No campaigns yet.</p>
            <button className="secondary" onClick={() => firstFieldRef.current?.focus()}>Create your first campaign</button>
          </div>
        ) : (
          <ul className="dirs" aria-label="Campaign list" style={{ minHeight: 120 }}>
            {list.map((c) => (
              <li key={c.campaignId} className={c.campaignId === id ? "active" : undefined} style={{ cursor: "pointer" }} onClick={() => setId(c.campaignId)}>
                <strong>{c.name}</strong> <span className="mono muted small">{c.transformationHash.slice(0, 10)}</span>{" "}
                <span className="chip">{c.state}</span> <span className="chip muted">population v{c.populationVersion ?? "—"}</span>{" "}
                {countRows(c.counts).map((r) => <span key={r.state} className={toneChip(stateCell(r.state).tone)}>{r.count} {stateCell(r.state).label}</span>)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Create a campaign">
        <h3>New campaign</h3>
        <fieldset className="form-fieldset">
          <legend>Identity</legend>
          <div className="form-grid">
            <FormField
              label="Campaign name"
              htmlFor="campaign-name"
              required
              error={touched && !name.trim() ? "Campaign name is required." : null}
              helper="A short name for this coordinated rollout."
            >
              <input
                id="campaign-name"
                ref={firstFieldRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Migrate shared library to v2"
                aria-required="true"
              />
            </FormField>

            <FormField label="Type" htmlFor="campaign-type" required helper="What kind of transformation to run.">
              <select id="campaign-type" value={recipeId} onChange={(e) => setRecipeId(e.target.value)} aria-required="true">
                {RECIPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </FormField>

            <FormField label="Version" htmlFor="campaign-version" required helper="Recipe or transformer version.">
              <input
                id="campaign-version"
                value={recipeVersion}
                onChange={(e) => setRecipeVersion(e.target.value)}
                placeholder="e.g. 1.0.0"
                aria-required="true"
              />
            </FormField>
          </div>
        </fieldset>

        <fieldset className="form-fieldset">
          <legend>Execution limits</legend>
          <div className="form-grid three">
            <NumberField
              id="canary-size"
              label="Canary size"
              value={canarySize}
              onChange={setCanarySize}
              min={0}
              max={100}
              helper="Repositories in the first batch."
            />
            <NumberField
              id="max-concurrent"
              label="Max concurrent"
              value={maxConcurrent}
              onChange={setMaxConcurrent}
              min={1}
              max={10}
              helper={
                <>
                  Max parallel child campaigns (1–10). Higher = faster, but more GitHub API load.{" "}
                  <InfoTip label="Concurrency guidance">Raising this increases GitHub API calls and server load.</InfoTip>
                </>
              }
            />
            <NumberField
              id="github-writes"
              label="GitHub writes"
              value={githubWrites}
              onChange={setGithubWrites}
              min={0}
              max={1000}
              helper="Max PRs / comments CIE may write."
            />
          </div>
        </fieldset>

        <fieldset className="form-fieldset">
          <legend>Scope</legend>
          <FormField
            label="Repository IDs"
            htmlFor="campaign-repos"
            helper="Leave empty to use the default language-based selector. Add IDs to run on specific repositories only."
          >
            <ChipInput
              id="campaign-repos"
              values={explicit}
              onChange={setExplicit}
              placeholder="repo-id-1"
            />
          </FormField>
        </fieldset>

        <div className="modal-actions" style={{ borderTop: "none", paddingTop: 4, justifyContent: "flex-end" }}>
          <button className="primary" onClick={create} disabled={busy !== null} aria-busy={busy === "create"}>
            {busy === "create" && <span className="spinner" aria-hidden="true" />}Create
          </button>
        </div>
      </section>

      {view && (
        <>
          <section aria-label="Campaign header">
            <h3>{view.campaign.name} <span className="chip">{view.campaign.state}</span></h3>
            <p className="muted small">
              transformation <span className="mono">{view.campaign.transformationHash.slice(0, 16)}</span>;{" "}
              population {view.population ? <>v{view.population.version} <span className="mono">{view.population.populationHash.slice(0, 16)}</span></> : "not frozen"};{" "}
              budgets — wall {view.usage?.wallMs ?? 0} ms, tokens {view.usage?.modelTokens ?? 0}/{view.budget?.modelTokens ?? "—"}, GitHub writes {view.usage?.githubWrites ?? 0}/{view.budget?.githubWrites ?? "—"}
            </p>
            <p className="muted small">{progressText(view.progress.completed, view.progress.total)}. {CAMPAIGN_COPY.completed}</p>
            <span className="row" role="group" aria-label="Campaign controls">
              <button onClick={() => act("freeze", "C28", "freezePopulation", { campaignId: id, expectedVersion: version() })} disabled={busy !== null}>Freeze population</button>
              <button onClick={() => act("plan", "C28", "planCampaign", { campaignId: id, expectedVersion: version() })} disabled={busy !== null}>Plan</button>
              <button onClick={() => act("advance", "C28", "advanceCampaign", { campaignId: id, expectedVersion: version() })} disabled={busy !== null}>Advance next batch</button>
              <button className="secondary" onClick={() => act("pause", "C28", "pauseCampaign", { campaignId: id, expectedVersion: version(), reason: "paused from the campaign panel" })} disabled={busy !== null}>Pause</button>
              <button className="secondary" onClick={() => act("resume", "C28", "resumeCampaign", { campaignId: id, expectedVersion: version() })} disabled={busy !== null}>Resume</button>
              <button className="secondary" onClick={() => act("cancel", "C28", "cancelCampaign", { campaignId: id, expectedVersion: version(), reason: "cancelled from the campaign panel" })} disabled={busy !== null}>Cancel</button>
              <button className="secondary" onClick={() => act("reconcile", "C30", "reconcileCampaign", { campaignId: id })} disabled={busy !== null}>Reconcile</button>
              <button className="secondary" onClick={publishAll} disabled={busy !== null}>Publish</button>
              <button className="secondary" onClick={() => wrap("dry-run", () => call<DryRunResult>("C28", "runDryRun", { campaignId: id, expectedVersion: version() }, uuid()), (v) => setDry(v as DryRunResult))} disabled={busy !== null}>Dry run</button>
            </span>
          </section>

          <section aria-label="Order and rollback">
            <h3>Order and rollback</h3>
            {plan?.order.cycles.length ? <p className="chip incomplete">{plan.order.cycles.length} dependency cycle(s) need a human decision; no order was invented.</p> : <p className="muted small">No dependency cycle; producers precede their consumers.</p>}
            <table className="matrix" aria-label="Recommended merge order"><tbody>
              {plan?.order.mergeOrder.map((m) => (
                <tr key={m.repositoryId}><td className="mono">{m.repositoryId}</td><td>{m.role}</td><td className="muted small">{m.batchId} · {m.reason}{m.dependsOnRepositoryIds.length ? ` · after ${m.dependsOnRepositoryIds.join(", ")}` : ""}</td></tr>
              ))}
            </tbody></table>
            {plan?.order.notSafeToReorder.length ? <p className="muted small">Not safe to reorder: {plan.order.notSafeToReorder.map((r) => `${r.producer}→${r.consumer} (${r.mode} ${compatibilityLabel(r.state)})`).join("; ")}</p> : null}
            <p className="muted small">External effects CIE cannot control: {plan?.order.externalEffects.join(", ") ?? "—"}.</p>
          </section>

          <section aria-label="Batch timeline">
            <h3>Batches</h3>
            <table className="matrix" aria-label="Batch timeline"><tbody>
              {plan?.batches.map((b) => (
                <tr key={b.batchId}><td className="mono">{b.batchId}</td><td>{b.kind}</td><td>{b.state}</td><td>{b.members.length} child(ren)</td><td className="muted small">{b.dependsOn.length ? `after ${b.dependsOn.join(", ")}` : "starts first"}</td></tr>
              ))}
            </tbody></table>
          </section>

          <section aria-label="Children">
            <h3>Children</h3>
            <span className="row">
              <label>state <select aria-label="Filter by state" value={filter.state} onChange={(e) => setFilter({ ...filter, state: e.target.value })}><option value="">all</option>{["NOT_STARTED", "RUNNING", "REVIEW_READY", "PUBLISHED", "FAILED", "BLOCKED", "STALE", "EXCLUDED"].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
              <label><input type="checkbox" checked={filter.failed} onChange={(e) => setFilter({ ...filter, failed: e.target.checked })} /> failed</label>
              <label><input type="checkbox" checked={filter.stale} onChange={(e) => setFilter({ ...filter, stale: e.target.checked })} /> stale</label>
              <label><input type="checkbox" checked={filter.needsAssessment} onChange={(e) => setFilter({ ...filter, needsAssessment: e.target.checked })} /> needs assessment</label>
              <button className="secondary" onClick={() => void refresh()} disabled={busy !== null}>Refresh</button>
            </span>
            <table className="matrix" aria-label="Children table">
              <thead><tr><th>repository</th><th>role</th><th>state</th><th>validation</th><th>PR</th><th>owner</th><th>exception</th></tr></thead>
              <tbody>
                {rowsToShow.map((r) => {
                  const s = stateCell(r.state);
                  return (
                    <tr key={r.repositoryId}>
                      <td className="mono">{r.repositoryId}{r.stale ? " ↻" : ""}{r.assessmentState === "NEEDS_ASSESSMENT" ? " ⚠" : ""}</td>
                      <td>{r.role}</td>
                      <td><span className={toneChip(s.tone)}>{s.glyph} {s.label}</span>{r.reason ? <span className="muted small"> — {r.reason}</span> : null}</td>
                      <td className="muted small">{r.validation ? `${r.validation.passed}/${r.validation.runs} runs passed` : "—"}</td>
                      <td className="muted small">{r.pr ? `#${r.pr.number} ${r.pr.state}` : "not published"}</td>
                      <td className="muted small">{r.author ?? "—"}{r.approved ? " ✓ approved" : ""}</td>
                      <td className="muted small">{r.exception ? "exception" : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {view.population === null ? <p className="muted small">Freeze the population to see children.</p> : null}
          </section>

          <section aria-label="Compatibility">
            <h3>Compatibility (tabular equivalent of the graph)</h3>
            <table className="matrix" aria-label="Compatibility cases">
              <thead><tr><th>producer</th><th>consumer</th><th>mode</th><th>state</th><th>reason</th></tr></thead>
              <tbody>
                {compat.map((c) => (
                  <tr key={c.caseId}>
                    <td className="mono">{c.producerRepository}</td><td className="mono">{c.consumerRepository}</td><td>{c.mode}</td>
                    <td><span className={toneChip(compatibilityTone(c.state))}>{compatibilityLabel(c.state)}</span></td>
                    <td className="muted small">{c.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section aria-label="Review queue">
            <h3>Review queue</h3>
            {unclustered > 0 && <p className="muted small">{unclustered} child(ren) have no materialised candidate to cluster yet.</p>}
            <ul className="dirs" aria-label="Diff clusters">
              {clusters.map((cl) => (
                <li key={cl.clusterId}>
                  <span className="chip muted mono">{cl.clusterId}</span> representative <span className="mono">{cl.representativeRepositoryId}</span>
                  <ul>
                    {cl.members.map((m) => (
                      <li key={m.repositoryId} className="muted small">
                        <span className="mono">{m.repositoryId}</span> <span className="mono">{m.bindingHash.slice(0, 10)}</span> {m.approved ? <span className="chip pass">approved</span> : <span className="chip muted">unapproved</span>}
                        <button className="link" onClick={() => act("confirm", "C28", "confirmCluster", { campaignId: id, repositoryId: m.repositoryId, clusterId: cl.clusterId, expectedBindingHash: m.bindingHash })}>confirm</button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {clusters.length === 0 && <li className="muted small">No clusters yet.</li>}
            </ul>
            <span className="row">
              <input aria-label="Reason for approval" value={approveWhy} onChange={(e) => setApproveWhy(e.target.value)} placeholder="why you approve (required, per child)" style={{ flex: "1 1 18rem" }} />
              <label>child <select aria-label="Child to approve" onChange={(e) => { const rid = e.target.value; if (rid) act("approve", "C28", "approveChild", { campaignId: id, repositoryId: rid, explanation: approveWhy }); }} defaultValue=""><option value="">choose…</option>{rowsToShow.filter((r) => r.state === "REVIEW_READY").map((r) => <option key={r.repositoryId} value={r.repositoryId}>{r.repositoryId}</option>)}</select></label>
            </span>
            <p className="muted small">{CAMPAIGN_COPY.noAggregate} Approving one child never approves another; clusters are a review aid only.</p>
          </section>

          <section aria-label="Population changes">
            <h3>Population changes since freeze</h3>
            <button className="secondary" onClick={() => act("diff", "C28", "assessPopulationChange", { campaignId: id, fromVersion: Math.max(1, (view.population?.version ?? 1) - 1), toVersion: view.population?.version ?? 1 }, false)} disabled={busy !== null || (view.population?.version ?? 1) < 2}>Compute diff</button>
            {diff && (
              <table className="matrix" aria-label="Population diff"><tbody>
                {diff.entries.filter((e) => e.change !== "UNCHANGED").map((e) => (
                  <tr key={e.repositoryId}><td className="mono">{e.repositoryId}</td><td>{e.change}</td><td>{e.state}</td><td className="muted small">{e.reason}</td>
                    <td>{e.state === "NEEDS_ASSESSMENT" ? <button className="link" onClick={() => act("assess", "C28", "assessChild", { campaignId: id, repositoryId: e.repositoryId })}>assess</button> : null}</td></tr>
                ))}
              </tbody></table>
            )}
          </section>

          {dry && (
            <section aria-label="Dry run">
              <h3>Dry run <span className="chip muted">no branch, no pull request</span></h3>
              <p className="muted small">{dry.note}</p>
              <table className="matrix" aria-label="Dry run results"><tbody>
                {dry.repositories.map((r) => (
                  <tr key={r.repositoryId}><td className="mono">{r.repositoryId}</td><td>{r.applies ? `${r.files.length} file(s)` : "does not apply"}</td><td>{r.forbiddenPaths.length ? <span className="chip fail">forbidden: {r.forbiddenPaths.join(", ")}</span> : ""}</td><td className="muted small">{r.validation ? `${r.validation.state}${r.validation.reason ? ` — ${r.validation.reason}` : ""}` : r.reason}</td></tr>
                ))}
              </tbody></table>
            </section>
          )}
        </>
      )}

      <p className="muted small" style={{ marginTop: "auto" }}>
        {CAMPAIGN_COPY.draft}{" "}
        <InfoTip label="Visibility note">{CAMPAIGN_COPY.hiddenNote}</InfoTip>
      </p>
    </Modal>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  helper,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  helper?: React.ReactNode;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  return (
    <FormField label={label} htmlFor={id} helper={helper}>
      <span className="number-field">
        <button type="button" className="step" aria-label={`Decrease ${label}`} onClick={() => onChange(clamp(value - 1))}>-</button>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(clamp(n));
          }}
        />
        <button type="button" className="step" aria-label={`Increase ${label}`} onClick={() => onChange(clamp(value + 1))}>+</button>
      </span>
    </FormField>
  );
}
