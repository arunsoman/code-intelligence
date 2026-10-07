import type { Relationship } from "@cie/schema";
import type { RevisionRow, Store } from "./store.ts";
import { policyFor } from "./access.ts";
import { baseView, containsEvidence, nodeBase, observation } from "./forms/common.ts";
import { testFactsFor } from "./testartifacts.ts";
import type { Built } from "./visuals.ts";

export const isTestFile = (file: string) => /(^|\/)(__tests__|tests?)(\/|$)|[._-](test|spec)\.[^/]+$/i.test(file);
export const isNonProductionFile = (file: string) => isTestFile(file) || /(^|\/)(\.cie|fixtures?|examples?|vendor|node_modules)(\/|$)/i.test(file);

/** Test reachability is evidence of a static link, never evidence that assertions
 * passed. File imports are shown separately when calls cannot be resolved. */
export function moduleTests(store: Store, rev: RevisionRow, question: string, subject: string): Built {
  const access = policyFor(store, rev.repoRoot);
  const entities = store.entities(rev.id).filter((e) => !access.denied(e.file));
  const files = entities.filter((e) => e.kind === "file");
  const exact = files.find((e) => e.file === subject || e.entityId === subject);
  const matching = exact ? [exact] : files.filter((e) => e.file.toLowerCase().includes(subject.toLowerCase()) && !isNonProductionFile(e.file));
  if (matching.length !== 1) throw new Error(matching.length ? `“${subject}” matches ${matching.length} files; select one file to inspect its tests.` : `No accessible indexed file matches “${subject}”.`);
  const file = matching[0];
  const v = baseView({ rev, question, form: "TestConfidence", kind: "module-tests", caption: "", reason: "Tests linked to the selected source file, with static reach separated from measured coverage." });
  v.params = { subject: file.file }; v.meta = { kind: "testconf", subject: file.file };
  const sourceEvidence = observation(store, rev.id, `module-tests:${file.file}`, "TEST", file.file, `Static test lookup for ${file.file}; at most four parsed call edges, plus direct test-file imports.`).id;
  const rootId = `n:module:${file.file}`;
  const coverage = testFactsFor(store, rev.id, file.entityId).coverage;
  v.nodes.push(nodeBase(file, { id: rootId, evidenceIds: [sourceEvidence, ...(coverage?.evidenceIds ?? [])], tier: "CRITICAL", role: "behavior", notes: [coverage ? `Recorded line coverage: ${coverage.percent}% (${coverage.covered}/${coverage.lines}).` : "No recorded line coverage for this file."] }));
  const byId = new Map(entities.map((e) => [e.entityId, e]));
  const incoming = new Map<string, Relationship[]>();
  const rels = store.allRelationships(rev.id).filter((r) => byId.has(r.from) && byId.has(r.to));
  for (const r of rels) if (r.kind === "calls" && r.resolution !== "UNRESOLVED") incoming.set(r.to, [...(incoming.get(r.to) ?? []), r]);
  const paths = new Map<string, Relationship[]>();
  let frontier = entities.filter((e) => e.file === file.file && e.kind !== "file" && e.kind !== "test").map((e) => e.entityId);
  for (const id of frontier) paths.set(id, []);
  for (let depth = 0; depth < 4; depth++) {
    const next: string[] = [];
    for (const id of frontier) for (const r of incoming.get(id) ?? []) if (!paths.has(r.from)) { paths.set(r.from, [r, ...paths.get(id)!]); next.push(r.from); }
    frontier = next;
  }
  const reached = entities.filter((e) => e.kind === "test" && paths.has(e.entityId));
  const reachedFiles = new Set(reached.map((e) => e.file));
  const imports = rels.filter((r) => r.kind === "imports" && r.to === file.entityId && isTestFile(byId.get(r.from)!.file) && !reachedFiles.has(byId.get(r.from)!.file));
  const matches = [
    ...reached.map((e) => ({ e, mode: "calls" as const, evidenceIds: paths.get(e.entityId)!.flatMap((r) => r.evidence.map((x) => x.id)) })),
    ...imports.map((r) => ({ e: byId.get(r.from)!, mode: "imports" as const, evidenceIds: r.evidence.map((e) => e.id) })),
  ];
  for (const { e, mode, evidenceIds } of matches.slice(0, 60)) {
    const id = `n:test-link:${e.entityId}`;
    v.nodes.push(nodeBase(e, { id, evidenceIds: [...new Set([...evidenceIds, ...containsEvidence(store, rev.id, e.entityId)])], role: "test", badge: mode === "calls" ? "static call path" : "imports only", notes: [mode === "calls" ? "A parsed call path reaches this file; this does not prove assertions or passing tests." : "This test file imports the module; execution and coverage are not established."] }));
    v.edges.push({ id: `e:test-link:${e.entityId}`, fromNodeId: id, toNodeId: rootId, kind: mode === "calls" ? "statically reaches" : "imports", evidenceIds: [...new Set(evidenceIds)], displayMode: "FACT" });
  }
  v.caption = `Tests for ${file.file}: ${reached.length} test(s) reach it through parsed calls; ${imports.length} additional test/support file(s) import it. ${coverage ? `Recorded line coverage: ${coverage.percent}% (${coverage.covered}/${coverage.lines} lines).` : "No measured line coverage is available."}`;
  v.gaps.push("Static reach is limited to four calls; dynamic calls and assertion quality are not established. Import links do not establish execution. This analysis does not run tests.");
  if (!matches.length) v.gaps.push("No static test links were found; this is not proof that the file is untested.");
  if (matches.length > 60) v.gaps.push(`Showing 60 of ${matches.length} test links.`);
  if (!coverage) v.gaps.push("No coverage report was found for this file.");
  return { view: v, claims: [] };
}
