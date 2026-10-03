// Runtime-ish signals that make code "hot" for ranking, each with a stated reason and evidence:
//  - exceptions reported by a running app (inbox), weighted by frame position and repetition
//  - failing tests, and the code those tests call
// None of this is live telemetry: it is what was reported or recorded, and the reasons say so.
import { createHash } from "node:crypto";
import type { EvidenceRef } from "@cie/schema";
import type { RevisionRow, Store } from "./store.ts";
import { locateFrames, parseTrace } from "./trace.ts";

export interface Hot { value: number; reason: string; evidenceIds: string[] }

const rtEvidence = (rev: string, key: string, file: string, locator: string, at: string): EvidenceRef => ({
  id: "ev:" + createHash("sha256").update(rev + key).digest("hex").slice(0, 16), sourceId: file,
  location: { kind: "RuntimeLocation", backendHandle: "exception-inbox", deploymentId: "reported", start: at, end: at, locator },
  class: "RUNTIME", observedAt: at, accessScopeId: "local", state: "CURRENT",
});

export function runtimeHotness(store: Store, rev: RevisionRow): Map<string, Hot> {
  const hot = new Map<string, Hot>();
  const put = (id: string, h: Hot) => { const cur = hot.get(id); if (!cur || h.value > cur.value) hot.set(id, h); };
  const entities = store.entities(rev.id);

  for (const ex of store.exceptions(false)) {
    const parsed = parseTrace(ex.trace);
    const located = locateFrames(store, rev, parsed, entities);
    let pos = 0;
    for (const f of located) {
      if (!f.entityId) { pos++; continue; }
      const repeat = 0.5 + 0.12 * Math.log2(1 + ex.count);
      const value = Math.min(1, repeat * Math.max(0.35, 1 - pos * 0.18));
      const e = rtEvidence(rev.id, `inbox:${ex.id}:${f.entityId}`, f.file ?? "", `${ex.errorClass} reported ${ex.count}× by ${ex.source}: ${f.frame.raw}`, ex.lastSeen);
      store.putEvidence(rev.id, e);
      put(f.entityId, { value, reason: `${pos === 0 ? "top frame" : `stack frame #${pos + 1}`} of ${ex.count} reported ${ex.errorClass} exception(s) (${ex.source})`, evidenceIds: [e.id] });
      pos++;
    }
  }

  // Failing tests make the code they exercise worth looking at (two call hops).
  const callsFrom = new Map<string, string[]>();
  for (const r of store.relationshipsAmong(rev.id, "calls")) callsFrom.set(r.from, [...(callsFrom.get(r.from) ?? []), r.to]);
  for (const f of store.factsByPredicate(rev.id, "test_result")) {
    const v = (f.object as { value?: { status?: string; name?: string } }).value;
    if (v?.status !== "failed") continue;
    const evidenceIds = f.evidence.map((e) => e.id);
    let frontier = [f.subject];
    for (let hop = 1; hop <= 2; hop++) {
      const next: string[] = [];
      for (const id of frontier) for (const to of callsFrom.get(id) ?? []) {
        put(to, { value: hop === 1 ? 0.7 : 0.45, reason: `${hop === 1 ? "called directly" : "reached"} by the failing test “${v.name}”`, evidenceIds });
        next.push(to);
      }
      frontier = next;
    }
  }
  return hot;
}
