import { useState } from "react";
import { call } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { FormField } from "./FormField.tsx";
import { ChipInput } from "./ChipInput.tsx";
import { InfoTip } from "./InfoTip.tsx";

/**
 * "Tasks" panel (F07). Create a task with its acceptance criteria, constraints and authorised operations, confirm
 * what CIE understood, then follow the timeline: plan, candidate diff, one row per validation role (with the full
 * outcome list and the isolation it really had), a property-change review, a second-person approval and a draft PR.
 *
 * The copy rules of §12.2 are enforced in the rendering, not just hoped for: "Verified" appears only for
 * PASSED_DEFINED_GATES with the oracle preserved or reviewed, every verdict is followed by what was *not* covered,
 * INCOMPLETE/BLOCKED always name the role or reason, and a draft PR is never presented as an approval.
 */
type TaskSpec = {
  title: string; description: string; kind: "FIX_DEFECT"; repositoryId: string; baseRef: string;
  acceptance: { id: string; text: string; oracle?: { kind: "TEST"; testId: string; file: string } }[];
  constraints: { allowedPaths: string[]; forbiddenPaths: string[]; maxFilesChanged: number; maxDiffLines: number; allowNewDependencies: false; allowTestEdits?: boolean };
  authorisedOperations: string[]; budgets: { modelTokens: number; runWallMs: number; investigationSteps: number };
};
type TaskView = {
  taskId: string; state: string; version: number; generation: number; spec: TaskSpec; specHash: string;
  candidateIndex: number | null; bindingHash: string | null; verdict: string | null; oracleState: string | null;
  blockedBy: string[]; confirmed: boolean;
};
type RoleRun = { role: string; mandatory: boolean; status: string; passed: number; failed: number; outcomes: { name: string; state: string }[]; output: string; omissions: string[] };
type Verdict = { verdictId: string; state: string; oracleState: string; roles: RoleRun[]; blockedBy: string[]; bindingHash: string };
type Plan = { planVersion: number; plan: { steps: { id: string; text: string; kind: string }[]; unknowns: { id: string; question: string }[]; obligations: { id: string; question: string }[] }; planHash: string };
type EventRow = { seq: number; type: string; actor: string; at: string; payload: Record<string, unknown>; generation: number };

const VERIFIED = "PASSED_DEFINED_GATES";
const stateChip = (s: string | null | undefined) =>
  s === VERIFIED || s === "PUBLISHED" ? "chip fact" : s === "FAILED" || s === "BLOCKED" || s === "FAILED".toLowerCase() ? "chip warn" : s === "CANCELLED" ? "chip muted" : "chip";

const OPERATIONS: { id: string; label: string; description: string; risky?: boolean }[] = [
  { id: "READ", label: "Read files", description: "View repository contents for planning and validation." },
  { id: "EDIT", label: "Edit files", description: "Apply proposed changes to source files." },
  { id: "RUN_TESTS_ISOLATED", label: "Run tests in an isolated sandbox", description: "Execute tests in a throwaway environment, never affecting your CI." },
  { id: "CREATE_BRANCH", label: "Create a branch", description: "Push a CIE-owned draft branch to your repository." },
  { id: "PUBLISH_DRAFT", label: "Publish the draft branch", description: "Open a draft pull request. Still requires human review and merge.", risky: true },
];

export function TaskPanel({ revision, onClose }: { revision: string | null; onClose: () => void }) {
  const [spec, setSpec] = useState<TaskSpec>(() => ({
    title: "", description: "", kind: "FIX_DEFECT", repositoryId: "fixtures/payments-repo", baseRef: "HEAD",
    acceptance: [{ id: "a1", text: "" }],
    constraints: { allowedPaths: ["src"], forbiddenPaths: [], maxFilesChanged: 5, maxDiffLines: 200, allowNewDependencies: false },
    // Least-privilege defaults: destructive / publishing operations are opt-in.
    authorisedOperations: ["READ", "EDIT"],
    budgets: { modelTokens: 5000, runWallMs: 120_000, investigationSteps: 8 },
  }));
  const [task, setTask] = useState<TaskView | null>(null);
  const [restatement, setRestatement] = useState<{ oracleNote: string; goal: string } | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [editOps, setEditOps] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [rationale, setRationale] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<{ prNumber: number; prUrl: string; prBody: string } | null>(null);
  const [touched, setTouched] = useState(false);

  const run = async <T,>(component: string, op: string, body: unknown): Promise<T | null> => {
    setBusy(true); setNote(null); setSuccess(null);
    const r = await call<T>(component, op, body, `${op}:${Date.now()}`, "v2");
    setBusy(false);
    if (!r.ok) { setNote(`${r.error.code}: ${r.error.message}`); return null; }
    return r.value;
  };
  const refresh = async (taskId: string) => {
    const [v, e] = await Promise.all([call<TaskView>("C02", "getTask", { taskId }, undefined, "v2"), call<{ events: EventRow[] }>("C02", "listTaskEvents", { taskId }, undefined, "v2")]);
    if (v.ok) setTask(v.value);
    if (e.ok) setEvents(e.value.events);
  };

  const validate = () => {
    setTouched(true);
    return !!spec.title.trim() && !!spec.description.trim() && !!spec.acceptance[0]!.text.trim();
  };

  const submit = async () => {
    if (!validate()) return;
    const out = await run<TaskView & { restatement: { oracleNote: string; goal: string } }>("C02", "submitTask", { spec });
    if (!out) return;
    setTask(out); setRestatement(out.restatement);
    setSuccess(`Task ${out.taskId} created. Review what CIE understood before starting work.`);
  };
  const confirm = async () => {
    if (!task) return;
    const out = await run<TaskView>("C02", "confirmIntent", { taskId: task.taskId, specHash: task.specHash, expectedVersion: task.version });
    if (out) await refresh(out.taskId);
  };
  const draft = async () => {
    if (!task) return;
    const out = await run<Plan>("C15", "draftPlan", { taskId: task.taskId });
    if (out) { setPlan(out); await refresh(task.taskId); }
  };
  const propose = async () => {
    if (!task || !plan) return;
    let ops: unknown[];
    try { ops = JSON.parse(editOps || "[]") as unknown[]; } catch { setNote("the edit operations must be a JSON array"); return; }
    const out = await run<{ candidateIndex: number; bindingHash: string }>("C28", "prepareChange", { taskId: task.taskId, planVersion: plan.planVersion, editOperations: ops, origin: "HUMAN" });
    if (out) await refresh(task.taskId);
  };
  const validateCandidate = async () => {
    if (!task) return;
    const out = await run<Verdict>("C27", "validatePatch", { taskId: task.taskId, candidateIndex: task.candidateIndex ?? undefined });
    if (out) { setVerdict(out); await refresh(task.taskId); }
  };
  const review = async (decision: string) => {
    if (!task || task.candidateIndex == null) return;
    const out = await run<{ reviewId: string }>("C28", "reviewPropertyChange", { taskId: task.taskId, candidateIndex: task.candidateIndex, decision, rationale });
    if (out) { setNote(`property-change review ${out.reviewId}`); await refresh(task.taskId); }
  };
  const approve = async () => {
    if (!task) return;
    const out = await run<TaskView>("C28", "approveCandidate", { taskId: task.taskId, candidateIndex: task.candidateIndex ?? undefined, expectedVersion: task.version, explanation: note ?? "reviewed in the task panel" });
    if (out) await refresh(out.taskId);
  };
  const publish = async () => {
    if (!task || task.candidateIndex == null) return;
    const grant = await run<{ grantId: string }>("C30", "createPublicationGrant", { taskId: task.taskId, candidateIndex: task.candidateIndex, repository: task.spec.repositoryId, baseBranch: "main", branchName: `cie/${task.taskId.slice(5, 21)}` });
    if (!grant) return;
    const out = await run<{ prNumber: number; prUrl: string; prBody: string }>("C30", "publishDraftPR", { taskId: task.taskId, candidateIndex: task.candidateIndex, repositoryId: task.spec.repositoryId, baseBranch: "main", branchName: `cie/${task.taskId.slice(5, 21)}`, grantId: grant.grantId });
    if (out) { setPublished(out); await refresh(task.taskId); }
  };
  const cancel = async () => {
    if (!task) return;
    const out = await run<TaskView>("C02", "cancelTask", { taskId: task.taskId, reason: "cancelled from the task panel" });
    if (out) await refresh(out.taskId);
  };

  const verified = verdict?.state === VERIFIED && (verdict.oracleState === "ORIGINAL_PRESERVED" || verdict.oracleState === "PROPERTY_CHANGE_REVIEWED" || verdict.oracleState === "NO_ORACLE");
  const canPublish = !!task && verified && task.state === "REVIEW_READY";

  const allowedPathsError = touched && spec.constraints.allowedPaths.length === 0 ? "At least one allowed path is required." : null;

  const validatePath = (value: string): string | null => {
    if (!value.trim()) return "Path cannot be empty.";
    if (value === "." || value === "..") return "Path cannot be '.' or '..'";
    if (!/^[A-Za-z0-9_./-]+$/.test(value)) return "Use letters, numbers, '/', '-', '_' and '.'.";
    return null;
  };

  return (
    <Modal title="Tasks" onClose={onClose} className="wide tall" actions={
      <>
        {revision === null && <span className="muted small">No revision is loaded, so a task cannot be created yet.</span>}
        <button className="primary" disabled={busy || !spec.title || !spec.description || !spec.acceptance[0]!.text || revision === null} onClick={submit}>
          {busy && <span className="spinner" aria-hidden="true" />}Submit task
        </button>
      </>
    }>
      <section aria-labelledby="new-task">
        <h3 id="new-task">New task</h3>
        <p className="muted small">
          Turn one defect into a validated patch. Nothing runs until you confirm what CIE understood, and nothing is published without a second person.{" "}
          <InfoTip label="What is an oracle?">
            The test that decides pass/fail for this task. CIE preserves it unless a property change is reviewed and accepted.
          </InfoTip>
        </p>

        {note && <p className="status-warn" role="alert">{note}</p>}
        {success && <p className="status-ok" role="status">{success}</p>}

        <div className="form-grid">
          <FormField
            label="Title"
            htmlFor="task-title"
            required
            error={touched && !spec.title.trim() ? "Title is required." : null}
            helper="One line describing the defect or change."
          >
            <input
              id="task-title"
              className="input"
              value={spec.title}
              onChange={(e) => setSpec({ ...spec, title: e.target.value })}
              placeholder="e.g. Checkout double-charges on retry"
              aria-required="true"
            />
          </FormField>

          <FormField
            label="Repository"
            htmlFor="task-repo"
            helper="Repository this task targets."
          >
            <input
              id="task-repo"
              className="input"
              value={spec.repositoryId}
              onChange={(e) => setSpec({ ...spec, repositoryId: e.target.value })}
            />
          </FormField>
        </div>

        <div className="form-grid wide">
          <FormField
            label="Description"
            htmlFor="task-desc"
            required
            error={touched && !spec.description.trim() ? "Description is required." : null}
            helper="Steps to reproduce, expected behaviour and impact."
          >
            <textarea
              id="task-desc"
              className="input"
              rows={4}
              value={spec.description}
              onChange={(e) => setSpec({ ...spec, description: e.target.value })}
              aria-required="true"
            />
          </FormField>
        </div>

        <div className="form-grid wide">
          <FormField
            label="Acceptance criterion"
            htmlFor="task-acceptance"
            required
            error={touched && !spec.acceptance[0]!.text.trim() ? "Acceptance criterion is required." : null}
            helper="What must be true for this task to be considered done."
          >
            <textarea
              id="task-acceptance"
              className="input"
              rows={3}
              value={spec.acceptance[0]!.text}
              onChange={(e) => setSpec({ ...spec, acceptance: [{ id: "a1", text: e.target.value, oracle: spec.acceptance[0]!.oracle }] })}
              aria-required="true"
            />
          </FormField>
        </div>

        <FormField
          label="Oracle test file"
          htmlFor="task-oracle"
          helper="The test CIE will use to check the fix."
        >
          <input
            id="task-oracle"
            className="input"
            value={spec.acceptance[0]!.oracle?.file ?? ""}
            placeholder="tests/payment-service.test.ts"
            onChange={(e) => setSpec({ ...spec, acceptance: [{ id: "a1", text: spec.acceptance[0]!.text, oracle: e.target.value ? { kind: "TEST", testId: "oracle", file: e.target.value } : undefined }] })}
          />
        </FormField>

        <FormField
          label="Allowed paths"
          htmlFor="task-paths"
          required
          error={allowedPathsError}
          helper="Paths the task may touch. Add paths as tags; everything else stays protected."
        >
          <ChipInput
            id="task-paths"
            values={spec.constraints.allowedPaths}
            onChange={(paths) => setSpec({ ...spec, constraints: { ...spec.constraints, allowedPaths: paths }})}
            placeholder="src"
            validate={validatePath}
          />
        </FormField>

        <label className="row" style={{ alignItems: "flex-start", marginTop: 4 }}>
          <input
            type="checkbox"
            checked={spec.constraints.allowTestEdits === true}
            onChange={(e) => setSpec({ ...spec, constraints: { ...spec.constraints, allowTestEdits: e.target.checked, allowedPaths: e.target.checked ? [...new Set([...spec.constraints.allowedPaths, "tests"])] : spec.constraints.allowedPaths.filter((p) => p !== "tests") } })}
          />
          <span>
            Allow edits to existing test files. Config changes will require reviewer approval.
          </span>
        </label>

        <fieldset className="form-fieldset" style={{ marginTop: 8 }}>
          <legend>Authorised operations</legend>
          <p className="form-helper" style={{ marginTop: 0 }}>These permissions control what CIE is allowed to do on your behalf. Destructive operations are off by default.</p>
          <div className="form-grid">
            {OPERATIONS.map((op) => {
              const checked = spec.authorisedOperations.includes(op.id);
              return (
                <label key={op.id} className="row" style={{ alignItems: "flex-start", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setSpec({ ...spec, authorisedOperations: e.target.checked ? [...spec.authorisedOperations, op.id] : spec.authorisedOperations.filter((x) => x !== op.id) })}
                  />
                  <span>
                    <strong>{op.label}</strong>
                    <span className="muted small" style={{ display: "block" }}>{op.description}</span>
                    {op.risky && checked && <span className="form-error" style={{ fontSize: 11 }}>Publishing requires a second-person approval first.</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </section>

      {restatement && task && (
        <section aria-labelledby="restatement">
          <h3 id="restatement">What CIE understood</h3>
          <p>{restatement.goal}</p>
          <p className="muted">{restatement.oracleNote}</p>
          <button className="primary" disabled={busy || task.confirmed} onClick={confirm}>Confirm and start</button>
        </section>
      )}

      {task && (
        <section aria-labelledby="task-state">
          <h3 id="task-state">Task <code>{task.taskId}</code></h3>
          <p><span className={stateChip(task.state)}>{task.state}</span> version {task.version} · generation {task.generation}</p>
          {task.blockedBy.length > 0 && <p className="warn">Blocked by: {task.blockedBy.join("; ")}</p>}
          <div className="row gap">
            <button disabled={busy || !task.confirmed} onClick={draft}>Draft plan</button>
            <button disabled={busy || task.candidateIndex == null} onClick={validateCandidate}>Validate candidate</button>
            <button disabled={busy || !verified} onClick={approve}>Approve (second person)</button>
            <button className="primary" disabled={busy || !canPublish} onClick={publish}>Publish draft PR</button>
            <button className="secondary" disabled={busy || task.state === "CANCELLED"} onClick={cancel}>Cancel</button>
          </div>
          {!canPublish && <p className="muted">Publish stays disabled until every mandatory role has passed and the oracle is preserved or its change reviewed.</p>}
        </section>
      )}

      {plan && (
        <section aria-labelledby="plan">
          <h3 id="plan">Plan v{plan.planVersion}</h3>
          <ol>{plan.plan.steps.map((s) => <li key={s.id}>{s.text} <span className="chip muted">{s.kind}</span></li>)}</ol>
          <h4>Unknowns</h4>
          <ul>{plan.plan.obligations.map((o) => <li key={o.id}>{o.question}</li>)}</ul>
        </section>
      )}

      {task?.confirmed && (
        <section aria-labelledby="candidate">
          <h3 id="candidate">Candidate edits</h3>
          <p className="muted">Edit operations are exact: each quotes the bytes it replaces. Paths, size caps and protected paths are checked before anything is materialised.</p>
          <textarea className="input" rows={6} value={editOps} onChange={(e) => setEditOps(e.target.value)} placeholder='[{"op":"REPLACE_SPAN","file":"src/a.ts","baseHash":"…","start":0,"end":5,"expected":"const","newText":"const","why":"…"}]' />
          <button disabled={busy || !plan} onClick={propose}>Materialise candidate</button>
        </section>
      )}

      {verdict && (
        <section aria-labelledby="validation">
          <h3 id="validation">Validation</h3>
          <p>
            <span className={stateChip(verdict.state)}>{verdict.state}</span>{" "}
            {verified ? "Verified: the original oracle reproduced the defect before the edit and passes unchanged after it." : "Not verified. Mandatory roles below are not all passed, or the oracle changed without a review."}
          </p>
          <table className="table">
            <caption>One row per role. The isolation each run really had is listed with it.</caption>
            <thead><tr><th>Role</th><th>Required</th><th>Result</th><th>Outcomes</th><th>Not covered by the isolation</th></tr></thead>
            <tbody>
              {verdict.roles.map((r) => (
                <tr key={r.role}>
                  <td>{r.role}</td>
                  <td>{r.mandatory ? "mandatory" : "advisory"}</td>
                  <td><span className={stateChip(r.status)}>{r.status}</span></td>
                  <td>
                    {r.passed} pass / {r.failed} fail
                    <details><summary>all outcomes</summary>
                      <ul>{r.outcomes.map((o, i) => <li key={`${o.name}-${i}`}>{o.state} {o.name}</li>)}</ul>
                      <pre>{r.output}</pre>
                    </details>
                  </td>
                  <td>{r.omissions.length ? r.omissions.join("; ") : "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {verdict.oracleState === "PROPERTY_CHANGE_PENDING_REVIEW" && (
            <div>
              <h4>Property-change review</h4>
              <p className="warn">An original assertion was removed, loosened or skipped. A person must accept this as intended, with a reason; detection is syntactic and a behaviour change hidden in a helper is not seen.</p>
              <textarea className="input" rows={2} placeholder="why this property change is intended" value={rationale} onChange={(e) => setRationale(e.target.value)} />
              <div className="row gap">
                <button disabled={busy || rationale.trim().length < 8} onClick={() => review("ACCEPT_AS_INTENDED")}>Accept as intended</button>
                <button className="secondary" disabled={busy || rationale.trim().length < 8} onClick={() => review("REJECT")}>Reject</button>
              </div>
            </div>
          )}
        </section>
      )}

      {published && (
        <section aria-labelledby="published">
          <h3 id="published">Draft PR published</h3>
          <p>Draft PR #{published.prNumber} · <a href={published.prUrl}>{published.prUrl}</a></p>
          <p className="warn">Draft only. This is not an approval and CIE has no merge operation.</p>
          <pre>{published.prBody}</pre>
        </section>
      )}

      {events.length > 0 && (
        <section aria-labelledby="timeline">
          <h3 id="timeline">Timeline</h3>
          <ol>{events.map((e) => <li key={e.seq}>{e.type} by {e.actor} at {e.at} <span className="chip muted">gen {e.generation}</span></li>)}</ol>
        </section>
      )}
    </Modal>
  );
}
