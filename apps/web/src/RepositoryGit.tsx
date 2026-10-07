import { useEffect, useState } from "react";
import type { RepositoryGitInfo, RevisionInfo } from "@cie/schema";
import { call } from "./api.ts";

export function RepositoryGit({ repoPath, revision, disabled, onSwitch }: {
  repoPath: string; revision: RevisionInfo | null; disabled: boolean;
  onSwitch: (info: RepositoryGitInfo, branch: string, kind: "local" | "remote") => Promise<void>;
}) {
  const [info, setInfo] = useState<RepositoryGitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [switching, setSwitching] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchNotice, setFetchNotice] = useState<string | null>(null);
  const locked = disabled || switching || fetching;
  useEffect(() => {
    let live = true;
    setInfo(null); setError(null); setBranch("");
    if (!repoPath) return;
    const timer = setTimeout(async () => {
      const r = await call<RepositoryGitInfo>("C01", "repositoryGit", { repoPath });
      if (!live) return;
      if (r.ok) { setInfo(r.value); setBranch(r.value.branch ?? ""); }
      else setError(r.error.message);
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [repoPath, revision?.id, refresh]);
  useEffect(() => {
    const focus = () => setRefresh((n) => n + 1);
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);
  const switchBranch = async () => {
    if (!info || !branch) return;
    setSwitching(true); setActionError(null);
    try { await onSwitch(info, branch.startsWith("remote:") ? branch.slice(7) : branch, branch.startsWith("remote:") ? "remote" : "local"); }
    catch (e) { setActionError((e as Error).message); }
    finally { setSwitching(false); setRefresh((n) => n + 1); }
  };
  const fetchBranches = async () => {
    setFetching(true); setActionError(null); setFetchNotice(null);
    try {
      const r = await call<RepositoryGitInfo>("C01", "fetchBranches", { repoPath });
      if (!r.ok) { setActionError(r.error.message); return; }
      setInfo(r.value); setBranch(r.value.branch ?? "");
      setFetchNotice("Remote branches updated. Your checkout is unchanged.");
    } finally { setFetching(false); }
  };
  if (!repoPath) return null;
  return <div aria-label="Repository Git details" className="repository-git" style={{ overflowWrap: "anywhere" }}>
    {error && <p role="alert" className="error">{error}</p>}
    {actionError && <p role="alert" className="error">{actionError}</p>}
    {fetchNotice && <p role="status" className="muted small">{fetchNotice}</p>}
    {!info && !error && <p className="muted small">Reading Git details…</p>}
    {info && <>
      <p className="small"><strong>Source:</strong> Local checkout</p>
      {info.isGitRepo ? <>
        <p className="small"><strong>Current branch:</strong> {info.branch ?? "Detached HEAD"}<br />
          <strong>Commit:</strong> <code title={info.head ?? undefined}>{info.head?.slice(0, 10) ?? "No commits yet"}</code><br />
          {info.dirty ? "Uncommitted local changes" : "Clean checkout"}</p>
        <label htmlFor="repository-branch">Branch</label>
        <select id="repository-branch" style={{ maxWidth: "100%" }} value={branch} onChange={(e) => setBranch(e.target.value)} disabled={locked}>
          {!info.branch && <option value="">Choose a branch</option>}
          {info.branch && !info.branches.includes(info.branch) && <option value={info.branch}>{info.branch}</option>}
          <optgroup label="Local branches">{info.branches.map((b) => <option key={b} value={b}>{b}</option>)}</optgroup>
          <optgroup label="Remote branches">{(info.remoteBranches ?? []).map((b) => <option key={b.ref} value={`remote:${b.ref}`}>{b.remote}/{b.branch}{b.localBranch ? ` → ${b.localBranch} (local)` : ""}</option>)}</optgroup>
        </select>
        <button className="secondary small" disabled={locked || info.dirty || !branch || branch === info.branch} onClick={() => void switchBranch()}>{switching ? "Switching…" : "Switch branch and index"}</button>
        <p className="muted small">Switches this folder’s checkout and indexes its files. Remote branches create a local tracking branch, or reuse the branch already tracking them. {info.dirty ? "Commit or stash your changes first." : ""}</p>
        <button className="secondary small" disabled={locked || !(info.remotes?.length)} onClick={() => void fetchBranches()}>{fetching ? "Fetching branches…" : "Fetch remote branches"}</button>
        <p className="muted small">Remote branches reflect the last fetch. Fetch to discover new branches and remove deleted ones from the list.</p>
      </> : <p className="muted small">This folder is not a Git repository.</p>}
      <p className="small"><strong>Origin:</strong> <span style={{ overflowWrap: "anywhere" }}>{info.origin ?? "No remote configured"}</span></p>
      <p className="small"><strong>GitHub:</strong> {info.github
        ? `${info.github.repository} — ${info.github.credentialsAvailable ? "CLI credentials available; repository access not checked" : "No CLI credentials available. Run gh auth login on the server to connect."}`
        : "No github.com origin detected"}</p>
      <p className="muted small">GitHub features use the server’s GitHub CLI credentials. Fetching uses this checkout’s Git credentials. Switching does not pull or push; an existing local branch keeps its commits.</p>
    </>}
    {revision && <p className="small"><strong>Displayed index:</strong> <code title={revision.gitHead ?? revision.id}>{revision.gitHead?.slice(0, 10) ?? revision.id}</code><br />
      <span style={{ overflowWrap: "anywhere" }}>{revision.repoRoot}</span><br />
      {info && (revision.repoRoot !== info.repoRoot || revision.gitHead !== info.head) ? "The displayed index differs from this checkout. Index it to update the analysis." : "Snapshot from the last index; local edits require reindexing."}</p>}
    <button className="link small" disabled={locked} onClick={() => setRefresh((n) => n + 1)}>Refresh Git details</button>
  </div>;
}
