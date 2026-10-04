import type { MapOverlayEntity, MapOverlays, SourceSpan } from "@cie/schema";
import { policyFor } from "./access.ts";
import { Runtime } from "./runtime.ts";
import type { Store } from "./store.ts";
import { testFactsFor } from "./testartifacts.ts";

/** Decorations for requested entities; never compiles or rearranges a ViewSpec. */
export function mapOverlays(store: Store, revision: string, ids: string[], window: MapOverlays["window"]): MapOverlays {
  const rev = store.revision(revision)!;
  const access = policyFor(store, rev.repoRoot);
  const all = new Map(store.entities(revision).map((e) => [e.entityId, e]));
  const allowed = (id: string) => all.has(id) && !access.denied(all.get(id)!.file);
  const evidenceAllowed = (id: string) => {
    const e = store.evidence(revision, id);
    return !!e && !access.denied(e.sourceId) && (e.location.kind !== "CodeLocation" || !access.denied((e.location as { span: SourceSpan }).span.sourceId));
  };
  const incoming = new Map<string, { from: string; evidenceIds: string[] }[]>();
  for (const r of store.relationshipsAmong(revision, "calls")) {
    if (!allowed(r.from) || !allowed(r.to)) continue;
    incoming.set(r.to, [...(incoming.get(r.to) ?? []), { from: r.from, evidenceIds: r.evidence.map((e) => e.id).filter(evidenceAllowed) }]);
  }
  const records = new Runtime(store).queryWindow(revision, window);
  const rows: MapOverlayEntity[] = [];
  const unique = [...new Set(ids)];
  for (const id of unique.filter(allowed)) {
    const found = new Set<string>(), paths = new Set<string>(), seen = new Set([id]);
    if (all.get(id)?.kind === "test") found.add(id);
    let frontier = [id];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      const next: string[] = [];
      for (const target of frontier) for (const r of incoming.get(target) ?? []) {
        if (seen.has(r.from)) continue;
        seen.add(r.from); r.evidenceIds.forEach((e) => paths.add(e));
        if (all.get(r.from)?.kind === "test") found.add(r.from); else next.push(r.from);
      }
      frontier = next;
    }
    const coverage = testFactsFor(store, revision, id).coverage;
    const coverageIds = coverage?.evidenceIds.filter(evidenceAllowed) ?? [];
    const percent = coverage && coverageIds.length ? coverage.percent : null;
    let failed = 0;
    const evidenceIds = new Set(coverageIds);
    for (const tid of found) {
      const results = store.factsFor(revision, tid).filter((f) => f.predicate === "test_result" && f.evidence.some((e) => evidenceAllowed(e.id)));
      for (const f of results) {
        if ((f.object as { value?: { status?: string } }).value?.status === "failed") failed++;
        f.evidence.filter((e) => evidenceAllowed(e.id)).forEach((e) => evidenceIds.add(e.id));
      }
    }
    if (found.size) paths.forEach((e) => evidenceIds.add(e));
    const runtime: MapOverlayEntity["runtime"] = { spans: 0, errors: 0, exact: true, evidenceIds: [], notes: [] };
    for (const a of records) {
      const i = a.perEntity.findIndex((p) => p.entityId === id);
      if (i < 0 || !a.evidenceIds[i] || !evidenceAllowed(a.evidenceIds[i])) continue;
      const p = a.perEntity[i]; runtime.spans += p.spans; runtime.errors += p.errors; runtime.exact &&= p.exact;
      runtime.evidenceIds.push(a.evidenceIds[i]);
      if (!p.exact) runtime.notes.push("Attribution is inexact; a name match, revision mismatch, missing marker or sampling may apply.");
      if (a.samplingRate) runtime.notes.push(`Recorded sample at rate ${a.samplingRate}; counts are observed spans, not total traffic.`);
    }
    if (!runtime.spans) { runtime.exact = false; runtime.notes.push("No matching recorded spans in this window; this does not show that the code did not execute."); }
    runtime.notes = [...new Set(runtime.notes)];
    rows.push({ entityId: id, label: all.get(id)!.name, tests: {
      state: failed ? "FAILING" : percent !== null ? "MEASURED" : found.size && evidenceIds.size ? "LINKED" : "UNKNOWN",
      coveragePercent: percent, reachingTests: found.size, failedTests: failed, evidenceIds: [...evidenceIds],
      notes: [percent === null ? "No accessible line-coverage measurement." : `${percent}% measured line coverage; this does not establish behavioral correctness.`,
        `${found.size} test(s) found within three static caller hops; unresolved and indirect calls may be missing.`,
        ...(failed ? ["A reaching test has a recorded failure; this does not establish that this code caused it."] : [])],
    }, runtime });
  }
  return { revision, window, entities: rows, withheld: unique.length - rows.length, gaps: [
    "Layers describe the pinned revision. Test reports may predate the source; inspect citations before relying on them.",
    "Runtime uses ingested envelopes in the selected window, not live telemetry, pasted exceptions or indexed aggregate trace exports.",
  ] };
}
