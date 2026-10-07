// F12 §7.3: the agent edits files; the index describes an earlier revision. Every tool call passes through here first.
//  1. ask C13/changesSinceIndex (the only existing op that compares the work tree against the index);
//  2. if files changed and autoRefresh is on (default), enqueue an incremental index and wait up to a bounded time;
//  3. if the refresh cannot finish in time (or autoRefresh is off), answer about the indexed revision and say so in
//     the result — workingTreeChanged: true, the changed-file count, and a staleness gap. Silent staleness is a bug.
//  4. callers downgrade claims about entities in changed files one class (Fact → Inference) unless refresh succeeded.
import type { McpGateway } from "./client.ts";

export interface FreshnessState {
  /** The revision answers will be computed on. Empty string only when nothing is indexed at all. */
  revision: string;
  repoRoot: string | null;
  workingTreeChanged: boolean;
  changedFiles: number;
  /** Relative paths that changed; used for the per-claim downgrade, never echoed to the agent. */
  changedFileList: string[];
  /** True when a refresh ran and finished before the answer. */
  refreshed: boolean;
  /** The freshness compare itself could not run; tools surface this instead of guessing about staleness. */
  unavailable?: boolean;
  unavailableCode?: string;
}

export interface FreshnessOptions {
  autoRefresh?: boolean;
  /** §7.3.2: bounded wait for an incremental refresh. Default 10 seconds. */
  refreshWaitMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const NO_REVISION: FreshnessState = { revision: "", repoRoot: null, workingTreeChanged: false, changedFiles: 0, changedFileList: [], refreshed: false };

export class FreshnessGuard {
  private readonly autoRefresh: boolean;
  private readonly refreshWaitMs: number;
  private readonly now: () => number;
  private readonly gw: McpGateway;
  constructor(gw: McpGateway, opts: FreshnessOptions = {}) {
    this.gw = gw;
    this.autoRefresh = opts.autoRefresh ?? true;
    this.refreshWaitMs = opts.refreshWaitMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * §7.3 step 1–3. Never throws for an ordinary stale index: staleness is reported in the returned state so the tool
   * can state it in its result. Throws McpGatewayError only when the gateway itself is unreachable.
   */
  async beforeCall(): Promise<FreshnessState> {
    const stats = await this.gw.call("C13/revisionStats", {});
    if (!stats.ok || !stats.value || typeof (stats.value as { revision?: unknown }).revision !== "string" || !(stats.value as { revision: string }).revision) {
      return { ...NO_REVISION };
    }
    const revision = (stats.value as { revision: string }).revision;
    const repoRoot = (stats.value as { repoRoot?: string }).repoRoot ?? null;

    const changed = await this.gw.call("C13/changesSinceIndex", { revision });
    if (!changed.ok || !changed.value) {
      // The compare could not run (e.g. nothing to diff against): answer on the indexed revision without claims
      // about freshness either way; the tool surfaces the gateway error code if it needs to refuse.
      return { revision, repoRoot, workingTreeChanged: false, changedFiles: 0, changedFileList: [], refreshed: false, unavailable: true, unavailableCode: changed.ok ? "UNKNOWN" : changed.error.code };
    }
    const v = changed.value as { toRevision?: string; changed?: boolean; files?: { added?: string[]; removed?: string[]; changed?: string[] } };
    if (!v.changed) return { revision, repoRoot, workingTreeChanged: false, changedFiles: 0, changedFileList: [], refreshed: false };

    // Files moved since the index. Try a bounded refresh first (§7.3.2).
    if (this.autoRefresh && repoRoot) {
      const deadline = this.now() + this.refreshWaitMs;
      const enqueued = await this.gw.call("C07/enqueueIndex", { repoPath: repoRoot, revision, wait: true });
      if (enqueued.ok) {
        const nv = enqueued.value as { revision?: string } | undefined;
        if (nv && typeof nv.revision === "string" && nv.revision && nv.revision !== revision && this.now() <= deadline) {
          return { revision: nv.revision, repoRoot, workingTreeChanged: false, changedFiles: 0, changedFileList: [], refreshed: true };
        }
      }
      // Refresh failed or did not finish in time: answer on the indexed revision, staleness stated (§7.3.3).
    }
    const list = [...(v.files?.added ?? []), ...(v.files?.removed ?? []), ...(v.files?.changed ?? [])];
    return { revision, repoRoot, workingTreeChanged: true, changedFiles: list.length, changedFileList: list, refreshed: false };
  }

  /** §7.3.4: the staleness gap every stale answer carries, worded once, here. */
  stalenessGap(state: FreshnessState): string {
    return `${state.changedFiles} file(s) changed since the answer's revision; callers and tests may differ.`;
  }
}

/** True when a claim's evidence touches a file the working tree has since changed (the §7.3.4 downgrade trigger). */
export function claimTouchesChangedFile(paths: string[], state: FreshnessState): boolean {
  if (!state.workingTreeChanged || state.refreshed) return false;
  const changed = new Set(state.changedFileList);
  return paths.some((p) => changed.has(p));
}
