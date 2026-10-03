// V13 Ownership and Knowledge Map: who owns code formally (CODEOWNERS) and in practice (git), where knowledge is thin,
// and whose knowledge has gone stale. De facto ownership is an inference until someone who knows confirms it.
import type { Claim, ViewGroup } from "@cie/schema";
import { authorCounts, codeowners, fileLog, isGitRepo, ownersOf } from "../gitinfo.ts";
import type { RevisionRow, Store } from "../store.ts";
import { baseView, claimOf, emptyForm, flowGraph, observation, short } from "./common.ts";

const DAY = 86_400_000;

export function buildOwnership(store: Store, rev: RevisionRow, question: string, subject?: string) {
  const o = { rev, form: "Ownership" as const, question, kind: "ownership", caption: "", reason: "You asked about ownership and knowledge, so each file is placed under its owner, tinted by how thin the knowledge behind it is." };
  if (!isGitRepo(rev.repoRoot)) return emptyForm(o, "This folder is not a git repository, so there is no history to say who knows the code.");
  const flow = flowGraph(store, rev.id);
  const co = codeowners(rev.repoRoot);
  const files = store.entities(rev.id).filter((e) => e.kind === "file" && (flow.byFile.get(e.file)?.length ?? 0) > 0);
  if (!files.length) return emptyForm(o, "There are no source files to assess.");
  const want = subject?.toLowerCase();
  const pool = want ? files.filter((f) => f.file.toLowerCase().includes(want)) : files;
  const deg = (f: string) => (flow.byFile.get(f) ?? []).reduce((n, e) => n + (flow.out.get(e.entityId)?.length ?? 0) + (flow.inn.get(e.entityId)?.length ?? 0), 0);
  const chosen = [...pool].sort((a, b) => deg(b.file) - deg(a.file) || a.file.localeCompare(b.file)).slice(0, 36);
  if (!chosen.length) return emptyForm(o, `No file is named like “${subject}”.`);

  // Newest commit anywhere defines "now" for staleness, so results do not change with the wall clock.
  const newest = Math.max(...chosen.flatMap((f) => fileLog(rev.repoRoot, f.file, 1).map((c) => Date.parse(c.date))), 0);
  const v = baseView({ ...o, caption: "" });
  const claims: Claim[] = [];
  const ownerCol = new Map<string, number>(), ownerRows = new Map<string, number>();
  let thin = 0;
  for (const f of chosen) {
    const authors = authorCounts(rev.repoRoot, f.file);
    const total = authors.reduce((n, a) => n + a.commits, 0);
    // Recent work counts for more than old work: half-life of 180 days.
    const weight = (a: { commits: number; last: string }) => a.commits * Math.pow(0.5, Math.max(0, newest - Date.parse(a.last)) / (180 * DAY));
    const ranked = authors.map((a) => ({ ...a, w: weight(a), inactive: newest - Date.parse(a.last) > 180 * DAY })).sort((a, b) => b.w - a.w);
    const wsum = ranked.reduce((n, a) => n + a.w, 0) || 1;
    const top = ranked[0], share = top ? top.w / wsum : 1;
    let bus = 0, acc = 0; for (const a of ranked) { acc += a.w / wsum; bus++; if (acc >= 0.5) break; }
    const formal = ownersOf(co.rules, f.file);
    const ownerLabel = formal ? formal.owners[0] : top?.author ?? "unknown";
    const heat = total === 0 ? 0.5 : Math.min(1, 0.55 * share + 0.25 * (bus <= 1 ? 1 : 0) + 0.2 * (top?.inactive ? 1 : 0));
    const hist = observation(store, rev.id, `own:${f.file}`, "HISTORY", f.file, total ? `${f.file}: ${total} commit(s) by ${authors.map((a) => `${a.author} ${a.commits}`).join(", ")}${formal ? `; CODEOWNERS line ${formal.line}: ${formal.pattern} → ${formal.owners.join(" ")}` : ""}` : `${f.file}: no commits found`);
    if (!ownerCol.has(ownerLabel)) ownerCol.set(ownerLabel, ownerCol.size);
    const r = ownerRows.get(ownerLabel) ?? 0; ownerRows.set(ownerLabel, r + 1);
    const node = { id: `n:${f.entityId}`, entityRefs: [f.entityId], label: f.file.split("/").slice(-2).join("/"), kind: "file", file: f.file, claimIds: [] as string[], evidenceIds: [hist.id], tier: heat > 0.6 ? "CRITICAL" as const : "RELEVANT" as const, displayMode: "FACT" as import("@cie/schema").DisplayMode, unresolvedCalls: 0, role: "owned-file", pos: { x: ownerCol.get(ownerLabel)! * 280, y: r * 74 }, badge: ownerLabel, heat: { value: heat, label: total ? `${Math.round(share * 100)}% by ${top.author}; bus factor ${bus}${top?.inactive ? "; main contributor inactive" : ""}` : "no history" }, notes: [] as string[], ownClaimId: undefined as string | undefined };
    if (total) node.notes.push(`${total} commit(s) by ${authors.length} author(s): ${authors.slice(0, 4).map((a) => `${a.author} (${a.commits})`).join(", ")}.`);
    if (formal) node.notes.push(`Formal owner: ${formal.owners.join(", ")} (CODEOWNERS line ${formal.line}).`);
    if (bus <= 1 && total >= 2) { thin++; node.notes.push("Bus factor 1: a single person accounts for most of the knowledge."); }
    // De facto ownership is a claim; it needs a person who knows to confirm it.
    if (top) {
      // CODEOWNERS usually names teams, and a person cannot be matched to a team from git alone, so no mismatch is claimed.
      const c = claimOf(store, rev.id, { assertion: `${top.author} is the de facto owner of ${f.file} (${Math.round(share * 100)}% of recent-weighted commits)${formal ? `; its formal owner is ${formal.owners.join(", ")}, and team membership is not known here` : ""}.`, claimClass: "de-facto-ownership", evidenceIds: [hist.id], rationaleSummary: "Inferred from who changed the file, weighted toward recent work; it needs confirmation by someone who knows." });
      claims.push(c); node.claimIds = [c.draft.id]; node.ownClaimId = c.draft.id; node.displayMode = c.displayMode === "HIDDEN" ? "HYPOTHESIS" : "INFERENCE";
    }
    v.nodes.push(node);
  }
  const ids = new Set(v.nodes.map((n) => n.entityRefs[0]));
  for (const r of store.relationshipsAmong(rev.id, "imports")) if (ids.has(r.from) && ids.has(r.to)) v.edges.push({ id: `e:${r.id}`, fromNodeId: `n:${r.from}`, toNodeId: `n:${r.to}`, kind: "imports", relationshipId: r.id, evidenceIds: r.evidence.map((x) => x.id), displayMode: "FACT" });
  v.groups = [...ownerCol.keys()].map((owner): ViewGroup => ({ id: `g:region:${owner}`, label: owner, kind: "region", childNodeIds: v.nodes.filter((n) => n.badge === owner).map((n) => n.id), level: 2, evidenceIds: [], displayMode: "FACT" }));
  v.caption = `${chosen.length} file(s) under ${ownerCol.size} owner(s); ${thin} with bus factor 1. Warmer means thinner or staler knowledge.`;
  v.meta = { kind: "ownership", subject: subject ?? "" };
  v.params = subject ? { subject } : {};
  if (!co.path) v.gaps.push("There is no CODEOWNERS file, so ownership shown is de facto only: an inference until a team lead confirms it.");
  v.gaps.push("Review latency, on-call and ticket data are not connected; knowledge is judged from commits alone, and a commit is not proof of understanding.");
  return { view: v, claims };
}
