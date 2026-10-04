// C23: what changed between two revisions in terms of identities, behaviour and architecture; why code became what it is; what a
// change touches; and review threads that survive merges, renames and deletions. Chronology (commits, dates) is observed;
// anything about *why* stays an inference, and an issue that is referenced but not available is a stated gap, not a guess.
import { createHash, randomUUID } from "node:crypto";
import type { Claim, Entity, Fact } from "@cie/schema";
import { cycles, dependents } from "./graph.ts";
import { fileLog, forgeRefs, symbolLog, type Commit } from "./gitinfo.ts";
import { claimOf, observation } from "./forms/common.ts";
import { Registry } from "./registry.ts";
import type { Store } from "./store.ts";
import { testsReaching } from "./testartifacts.ts";

const SYMBOLS = new Set(["function", "method", "class"]);
const short = (id: string) => id.replace(/^[a-z]+:/, "").replace(/^.*#/, "");
const moduleOf = (file: string) => { const p = file.split("/"); return p.length > 2 ? p[1] : p[0]; };

export interface EntityChange { canonId: string | null; base: string | null; head: string | null; change: "ADDED" | "REMOVED" | "MODIFIED" | "RENAMED" | "MOVED" | "UNCHANGED" }
export interface Consequence {
  id: string; kind: "TRANSACTION_BYPASS" | "TRANSACTION_RESTORED" | "WRITE_REACH_CHANGED" | "MODULE_COUPLING" | "NEW_CYCLE" | "NEW_EXTERNAL_DEPENDENCY" | "ERROR_PATH_ADDED" | "CALL_ADDED" | "CALL_REMOVED" | "TESTS_LOST";
  text: string; evidenceIds: string[]; claimId: string; displayMode: Claim["displayMode"];
}
export interface ChangeSet {
  base: string; head: string; entities: EntityChange[];
  textDiff: { filesChanged: number; symbolsTouched: number };
  consequences: Consequence[]; claims: Claim[];
  blastRadius: { entityId: string; dependents: number; files: string[] }[];
  testImpact: { entityId: string; lost: string[]; gained: string[]; unchanged: string[] }[];
  gaps: string[];
}

function writers(store: Store, rev: string): Map<string, { fields: string[]; transactional: boolean; evidenceIds: string[] }> {
  const m = new Map<string, { fields: string[]; transactional: boolean; evidenceIds: string[] }>();
  const tx = new Set(store.factsByPredicate(rev, "uses_transaction").map((f) => f.subject));
  for (const f of store.factsByPredicate(rev, "writes")) {
    const cur = m.get(f.subject) ?? { fields: [], transactional: tx.has(f.subject), evidenceIds: [] };
    { const v = String((f.object as any).value ?? "?"); if (!cur.fields.includes(v)) cur.fields.push(v); } cur.evidenceIds.push(...f.evidence.map((e) => e.id)); m.set(f.subject, cur);
  }
  return m;
}
function reach(store: Store, rev: string, from: string, depth = 6): Map<string, string[]> {
  const out = new Map<string, string[]>(), adj = new Map<string, string[]>();
  for (const r of store.allRelationships(rev)) if (r.kind === "calls") adj.set(r.from, [...(adj.get(r.from) ?? []), r.to]);
  let frontier: [string, string[]][] = [[from, [from]]];
  const seen = new Set([from]);
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: [string, string[]][] = [];
    for (const [id, path] of frontier) for (const to of adj.get(id) ?? []) if (!seen.has(to)) { seen.add(to); out.set(to, [...path, to]); next.push([to, [...path, to]]); }
    frontier = next;
  }
  return out;
}

export class History {
  readonly store: Store;
  readonly registry: Registry;
  constructor(store: Store, registry = new Registry(store)) { this.store = store; this.registry = registry; }

  /** Pair entities of two revisions by canonical identity (a rename or move is one entity, not a removal and an addition). */
  private pair(base: string, head: string): EntityChange[] {
    const A = new Map(this.store.entities(base).filter((e) => SYMBOLS.has(e.kind)).map((e) => [e.entityId, e]));
    const B = new Map(this.store.entities(head).filter((e) => SYMBOLS.has(e.kind)).map((e) => [e.entityId, e]));
    const canonA = new Map([...A.keys()].map((id) => [id, this.registry.canonOf(base, id)])), canonB = new Map([...B.keys()].map((id) => [id, this.registry.canonOf(head, id)]));
    const headByCanon = new Map<string, string>(); for (const [id, c] of canonB) if (c) headByCanon.set(c, id);
    const used = new Set<string>(), out: EntityChange[] = [];
    for (const [id, e] of A) {
      const c = canonA.get(id) ?? null;
      const h = c ? headByCanon.get(c) : B.has(id) ? id : undefined;
      if (!h) { out.push({ canonId: c, base: id, head: null, change: "REMOVED" }); continue; }
      used.add(h);
      const he = B.get(h)!;
      const change = h === id ? (he.symbolHash === e.symbolHash ? "UNCHANGED" : "MODIFIED") : he.file !== e.file ? "MOVED" : "RENAMED";
      out.push({ canonId: c, base: id, head: h, change });
    }
    for (const [id] of B) if (!used.has(id)) out.push({ canonId: canonB.get(id) ?? null, base: null, head: id, change: "ADDED" });
    return out;
  }

  compare(base: string, head: string): ChangeSet {
    const store = this.store;
    const revHead = store.revision(head), revBase = store.revision(base);
    if (!revHead || !revBase) throw new Error("unknown revision");
    const entities = this.pair(base, head);
    const toHead = new Map(entities.filter((e) => e.base && e.head).map((e) => [e.base!, e.head!]));
    const touched = entities.filter((e) => e.change !== "UNCHANGED");
    const consequences: Consequence[] = [], claims: Claim[] = [], gaps: string[] = [];
    const claim = (kind: Consequence["kind"], text: string, evidenceIds: string[], cls = "change-consequence"): Consequence => {
      // A consequence says what is true in one revision and not the other. It never says one thing caused another.
      const c = claimOf(store, head, { assertion: text, claimClass: cls, evidenceIds: evidenceIds.length ? evidenceIds : [observation(store, head, `change:${base}:${head}:${kind}:${text}`, "HISTORY", revHead.repoRoot, text).id], rationaleSummary: `Compared revision ${base} with ${head}; both sides were read from the stored facts.` });
      claims.push(c);
      return { id: "csq:" + createHash("sha256").update(kind + text).digest("hex").slice(0, 10), kind, text, evidenceIds: c.draft.evidenceIds, claimId: c.draft.id, displayMode: c.displayMode };
    };
    const callEdges = (rev: string) => new Map(store.allRelationships(rev).filter((r) => r.kind === "calls").map((r) => [`${r.from}>${r.to}`, r]));
    const eb = callEdges(base), eh = callEdges(head);
    const mapHeadEdge = (key: string) => { const [a, b] = key.split(">"); return `${toHead.get(a) ?? a}>${toHead.get(b) ?? b}`; };
    const baseMapped = new Map([...eb].map(([k, r]) => [mapHeadEdge(k), r]));
    const touchedHead = new Set(touched.flatMap((t) => [t.head, t.base && toHead.get(t.base)]).filter(Boolean) as string[]);
    const edgeInTouched = (key: string) => key.split(">").some((x) => touchedHead.has(x));
    // Added and removed calls (identities mapped across renames, so a rename is not a removal plus an addition).
    for (const [k, r] of eh) if (!baseMapped.has(k) && edgeInTouched(k)) consequences.push(claim("CALL_ADDED", `${short(r.from)} now calls ${short(r.to)}.`, r.evidence.map((e) => e.id)));
    for (const [k, r] of baseMapped) if (!eh.has(k) && edgeInTouched(k)) {
      const ev = observation(store, head, `gone:${base}:${head}:${k}`, "HISTORY", revHead.repoRoot, `In revision ${base}, ${short(r.from)} called ${short(r.to)}; in ${head} it does not.`).id;
      consequences.push(claim("CALL_REMOVED", `${short(r.from)} no longer calls ${short(r.to)}.`, [ev]));
    }
    // New dependencies between modules that had none.
    const modEdges = (rev: string, fileOf: Map<string, string>) => new Set([...callEdgesOf(rev)].map(([a, b]) => `${moduleOf(fileOf.get(a) ?? "")}>${moduleOf(fileOf.get(b) ?? "")}`).filter((k) => k.split(">")[0] !== k.split(">")[1]));
    const callEdgesOf = (rev: string) => store.allRelationships(rev).filter((r) => r.kind === "calls").map((r) => [r.from, r.to] as const);
    const fileMap = (rev: string) => new Map(store.entities(rev).map((e) => [e.entityId, e.file]));
    const mb = modEdges(base, fileMap(base)), mh = modEdges(head, fileMap(head));
    for (const k of mh) if (!mb.has(k)) {
      const [from, to] = k.split(">");
      const r = [...eh.values()].find((x) => moduleOf(fileMap(head).get(x.from) ?? "") === from && moduleOf(fileMap(head).get(x.to) ?? "") === to)!;
      consequences.push(claim("MODULE_COUPLING", `The ${from} module now depends on the ${to} module; it did not in ${base}.`, r.evidence.map((e) => e.id)));
    }
    // Behaviour that follows the calls: which writers a changed function reaches, and whether they are transactional.
    const wB = writers(store, base), wH = writers(store, head);
    for (const t of touched.filter((x) => x.base && x.head && x.change !== "RENAMED" && x.change !== "MOVED")) {
      const rb = reach(store, base, t.base!), rh = reach(store, head, t.head!);
      const mappedB = new Map([...rb].map(([id, p]) => [toHead.get(id) ?? id, p]));
      for (const [id, path] of rh) {
        const w = wH.get(id); if (!w || mappedB.has(id)) continue;
        const ev = [...w.evidenceIds.slice(0, 1), ...store.relationshipsFor(head, path.at(-2)!).filter((r) => r.kind === "calls" && r.to === id).flatMap((r) => r.evidence.map((e) => e.id)).slice(0, 1)];
        if (!w.transactional) consequences.push(claim("TRANSACTION_BYPASS", `${short(t.head!)} now reaches ${short(id)}, which writes ${w.fields.join(", ")} outside a transaction; before the change it did not reach it.`, ev));
        else consequences.push(claim("WRITE_REACH_CHANGED", `${short(t.head!)} now reaches ${short(id)}, which writes ${w.fields.join(", ")} inside a transaction.`, ev));
      }
      for (const [id, path] of rb) {
        const w = wB.get(id); if (!w || rh.has(toHead.get(id) ?? id)) continue;
        const ev = observation(store, head, `lost-reach:${base}:${head}:${t.head}:${id}`, "HISTORY", revHead.repoRoot, `In revision ${base}, ${short(t.base!)} reached ${short(id)} through ${path.map(short).join(" → ")}.`).id;
        consequences.push(claim(w.transactional ? "TRANSACTION_RESTORED" : "WRITE_REACH_CHANGED", `${short(t.head!)} no longer reaches ${short(id)}, which writes ${w.fields.join(", ")}${w.transactional ? " inside a transaction" : ""}.`, [ev]));
      }
    }
    // New cycles and new external dependencies.
    const cyc = (rev: string, m: Map<string, string>) => new Set(cycles(store, rev).map((c) => c.map((x) => m.get(x) ?? x).sort().join(",")));
    const cb = cyc(base, toHead), ch = cyc(head, new Map());
    for (const c of ch) if (!cb.has(c)) consequences.push(claim("NEW_CYCLE", `A call cycle now exists among ${c.split(",").map(short).join(", ")}.`, []));
    const ext = (rev: string) => new Map(store.factsByPredicate(rev, "imports_external").map((f) => [String((f.object as any).value), f]));
    const xb = ext(base);
    for (const [name, f] of ext(head)) if (!xb.has(name)) consequences.push(claim("NEW_EXTERNAL_DEPENDENCY", `The code now imports the external package ${name}.`, f.evidence.map((e) => e.id)));
    const thr = (rev: string) => new Set(store.factsByPredicate(rev, "throws").map((f: Fact) => `${f.subject}|${String((f.object as any).value)}`));
    const tb = thr(base);
    for (const f of store.factsByPredicate(head, "throws")) { const inv = [...toHead].find(([, h]) => h === f.subject)?.[0] ?? f.subject; if (!tb.has(`${inv}|${String((f.object as any).value)}`)) consequences.push(claim("ERROR_PATH_ADDED", `${short(f.subject)} can now throw ${String((f.object as any).value)}.`, f.evidence.map((e) => e.id))); }

    // Blast radius and tests.
    const blastRadius = touched.filter((t) => t.head && t.change !== "ADDED").map((t) => { const d = dependents(store, head, t.head!, { maxDepth: 4 }); const ids = d.nodes.filter((n) => n.id !== t.head && !n.id.startsWith("test:")); const files = new Set(ids.map((n) => n.file ?? "").filter(Boolean)); return { entityId: t.head!, dependents: ids.length, files: [...files].sort() }; });
    const testImpact = touched.filter((t) => t.base && t.head).map((t) => {
      const tb2 = new Set(testsReaching(store, base, t.base!).map((x) => x.name)), th = new Set(testsReaching(store, head, t.head!).map((x) => x.name));
      return { entityId: t.head!, lost: [...tb2].filter((x) => !th.has(x)).sort(), gained: [...th].filter((x) => !tb2.has(x)).sort(), unchanged: [...th].filter((x) => tb2.has(x)).sort() };
    }).filter((x) => x.lost.length || x.gained.length);
    for (const ti of testImpact) if (ti.lost.length) consequences.push(claim("TESTS_LOST", `${ti.lost.join(", ")} no longer reach${ti.lost.length === 1 ? "es" : ""} ${short(ti.entityId)}.`, []));
    const filesChanged = new Set<string>();
    for (const t of touched) { const e = (t.head ? store.entitiesById(head, [t.head])[0] : store.entitiesById(base, [t.base!])[0]) as Entity | undefined; if (e) filesChanged.add(e.file); }
    if (!store.revision(head)?.gitHead) gaps.push("No git history is available, so the change has no commit chronology; only the two revisions' contents were compared.");
    return { base, head, entities, textDiff: { filesChanged: filesChanged.size, symbolsTouched: touched.length }, consequences, claims, blastRadius, testImpact, gaps };
  }

  /** What a change set touches beyond itself: dependents, tests, and the people whose files those dependents are. */
  assessChangeImpact(cs: ChangeSet): { entityId: string; dependents: number; files: string[]; tests: string[]; owners: string[] }[] {
    const rev = this.store.revision(cs.head)!;
    return cs.blastRadius.map((b) => {
      const owners = new Set<string>();
      for (const f of b.files) for (const c of fileLog(rev.repoRoot, f, 3)) owners.add(c.author);
      return { ...b, tests: testsReaching(this.store, cs.head, b.entityId).map((t) => t.name), owners: [...owners].sort() };
    });
  }

  /**
   * Why is this code the way it is: commits that touched it (observed), the issues and pull requests they name (observed text; their
   * content only if a forge is connected, else a stated gap), incidents that landed on it, and narrative claims that stay inferences.
   */
  archaeology(revision: string, entityId: string, window?: { from?: string; to?: string }) {
    const store = this.store;
    const rev = store.revision(revision);
    const e = store.entitiesById(revision, [entityId])[0];
    if (!rev || !e) throw new Error("unknown entity");
    const span = e.spans[0];
    let commits: Commit[] = [];
    try {
      const startLine = 1, endLine = 100000;
      const sl = symbolLog(rev.repoRoot, e.file, startLine, endLine, 30); commits = sl.commits.length ? sl.commits : fileLog(rev.repoRoot, e.file, 30);
    } catch { commits = fileLog(rev.repoRoot, e.file, 30); }
    void span;
    commits = commits.filter((c) => (!window?.from || c.date >= window.from) && (!window?.to || c.date <= window.to));
    const chronology = commits.map((c) => ({ hash: c.hash.slice(0, 10), date: c.date, author: c.author, subject: c.subject, evidenceId: observation(store, revision, `commit:${c.hash}:${entityId}`, "HISTORY", e.file, `Commit ${c.hash.slice(0, 10)} by ${c.author} on ${c.date.slice(0, 10)}: “${c.subject}”`).id }));
    const refs = chronology.flatMap((c) => forgeRefs(c.subject).map((r) => ({ ...r, commit: c.hash, evidenceId: c.evidenceId })));
    // A pull request that a connector has read is available as quoted, untrusted text; anything else named is a stated gap.
    const known = (n: number) => { const r = store.db.prepare("select json from ext_items where kind = 'pull_request' and external_id = ? order by ingested_at desc limit 1").get(String(n)) as any; return r ? JSON.parse(r.json) as { title: string; author: string; state: string; body: string } : null; };
    const fromForge: { ref: string; commit: string; title: string; author: string; state: string; quotedBody: string; evidenceId: string; untrusted: true }[] = [];
    const gaps = refs.flatMap((r) => {
      const label = `${r.kind === "pr" ? "PR" : "issue"} #${r.number}`;
      const item = r.kind === "pr" ? known(r.number) : null;
      if (item) {
        fromForge.push({ ref: label, commit: r.commit, title: item.title, author: item.author, state: item.state, quotedBody: item.body.slice(0, 400), untrusted: true, evidenceId: observation(store, revision, `forge:${label}`, "DOCUMENT", e.file, `${label} “${item.title}” by ${item.author} (${item.state}), read from the forge. Its text is quoted, not followed.`).id });
        return [];
      }
      return [{ ref: label, commit: r.commit, status: "NOT_AVAILABLE" as const, gap: `${r.kind === "pr" ? "Pull request" : "Issue"} #${r.number} is named by commit ${r.commit}, but its content was not available, so the reason behind that change is not established.` }];
    });
    const incidents = store.exceptions(true).filter((x: any) => String(x.trace).includes(e.file) && String(x.trace).includes(e.name.split(".").pop()!)).map((x: any) => ({ id: x.id, errorClass: x.error_class ?? x.errorClass, count: x.count, lastSeen: x.last_seen ?? x.lastSeen }));
    // Narrative: what a commit says it did is observed; that this is why the code is as it is stays an inference with its counter-argument.
    const narrative = chronology.slice(0, 5).map((c) => claimOf(store, revision, { assertion: `The change “${c.subject}” (${c.hash}) is part of why ${e.name} looks as it does.`, claimClass: "rationale", evidenceIds: [c.evidenceId], rationaleSummary: "Chronology is observed from the commit; the causal reading is an inference from its message and which file it touched." }));
    return { entity: entityId, chronology, references: refs, gaps, fromForge, incidents, narrative, order: "newest first; dates are observed, causes are inferred" };
  }

  // ---------------------------------------------------------------- review threads
  addThread(actor: string, req: { revision: string; entityId: string; text: string; line?: number }): { id: string } {
    const rev = this.store.revision(req.revision)!;
    const e = this.store.entitiesById(req.revision, [req.entityId])[0];
    if (!e) throw new Error("unknown entity");
    const canon = this.registry.canonOf(req.revision, req.entityId) ?? req.entityId;
    const id = "thr:" + randomUUID();
    this.store.db.prepare("insert into review_threads values (?,?,?,?,?,?,?,?,?,?,?)").run(id, rev.repoRoot, canon, req.revision, req.entityId, e.file, req.line ?? null, req.text, actor, "OPEN", new Date().toISOString());
    this.threadLog(id, "CREATED", { entityId: req.entityId, revision: req.revision });
    return { id };
  }
  private threadLog(id: string, event: string, detail: unknown) { this.store.db.prepare("insert into review_thread_history(thread_id, event, detail, at) values (?,?,?,?)").run(id, event, JSON.stringify(detail), new Date().toISOString()); }
  threads(repoRoot: string) { return this.store.db.prepare("select * from review_threads where repo_root = ? order by created_at, id").all(repoRoot) as any[]; }
  threadHistory(id: string) { return (this.store.db.prepare("select event, detail from review_thread_history where thread_id = ? order by seq").all(id) as any[]).map((r) => ({ event: r.event as string, detail: JSON.parse(r.detail) })); }

  /**
   * After a merge: every open thread follows its canonical identity to the merged revision (through renames, moves and confirmed
   * merges). A thread whose code is gone is kept, marked ORPHANED with where it last was, and never deleted.
   */
  reanchorThreads(mergedRevision: string): { moved: number; kept: number; orphaned: number } {
    const rev = this.store.revision(mergedRevision)!;
    let moved = 0, kept = 0, orphaned = 0;
    for (const t of this.threads(rev.repoRoot).filter((x) => x.state === "OPEN" || x.state === "ORPHANED")) {
      let ents = this.registry.entityIn(mergedRevision, t.canon_id);
      // Merged away: follow the confirmed merge history to the identity that survived.
      for (let hop = 0, c = t.canon_id as string; !ents.length && hop < 5; hop++) {
        const m = this.registry.history(c).filter((x) => x.event === "MERGED_INTO").at(-1);
        if (!m) break;
        c = m.detail.into; ents = this.registry.entityIn(mergedRevision, c);
      }
      const here = ents[0] ?? (this.store.entitiesById(mergedRevision, [t.entity_id])[0]?.entityId);
      if (!here) {
        if (t.state !== "ORPHANED") { this.store.db.prepare("update review_threads set state = 'ORPHANED' where id = ?").run(t.id); this.threadLog(t.id, "ORPHANED", { lastKnown: t.entity_id, revision: t.revision, reason: "the code it was about no longer exists" }); }
        orphaned++; continue;
      }
      const e = this.store.entitiesById(mergedRevision, [here])[0];
      if (here === t.entity_id && t.state === "OPEN") { kept++; this.store.db.prepare("update review_threads set revision = ? where id = ?").run(mergedRevision, t.id); continue; }
      this.store.db.prepare("update review_threads set revision = ?, entity_id = ?, file = ?, state = 'OPEN' where id = ?").run(mergedRevision, here, e.file, t.id);
      this.threadLog(t.id, "REANCHORED", { from: t.entity_id, to: here, revision: mergedRevision });
      moved++;
    }
    return { moved, kept, orphaned };
  }
}
