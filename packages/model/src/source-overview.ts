import type { EvidenceBundle, SourceOverviewOutput } from "@cie/schema";

const words = (name: string) => name.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_./:#-]+/g, " ").toLowerCase();

/** Offline inference uses implemented operations and their call edges, never documents. */
export function inferSourceOverview(bundle: EvidenceBundle): SourceOverviewOutput {
  const current = new Set(bundle.evidence.filter((ev) => ev.state === "CURRENT").map((ev) => ev.id));
  const excerpts = bundle.facts.filter((fact) => fact.predicate === "source_excerpt");
  const byId = new Map(bundle.entities.map((entity) => [entity.entityId, entity]));
  const supported = bundle.entities.filter((entity) => ["function", "method"].includes(entity.kind)).flatMap((entity) => {
    const evidenceIds = excerpts.filter((fact) => fact.subject === entity.entityId)
      .flatMap((fact) => fact.evidence.map((ev) => ev.id)).filter((id) => current.has(id));
    return evidenceIds.length ? [{ entity, evidenceIds }] : [];
  });
  const activities = supported.filter(({ entity }) => /^(?:create|build|ingest|index|analy[sz]e|extract|compile|render|reserve|rollback|post|charge|pay|process|send|publish|subscribe|search|detect|query|converse|ask|execute|validate|dispatch|export|import|generate)\b/.test(words(entity.name.split(/[.#]/).at(-1) ?? entity.name)));
  // Normalize conventional operation names into workflows only when an actual
  // implementation excerpt supports the operation. No repository-specific name
  // or documentation decides the result.
  const workflowNames: [RegExp, string][] = [
    [/\b(?:ingest repository|index repo(?:sitory)?)\b/, "indexing source repositories"],
    [/\bextract concepts?\b/, "extracting concepts from code"],
    [/\b(?:compile|generate|build) chart(?: plan)?\b/, "generating charts"],
    [/\b(?:converse|converse internal)\b/, "handling conversational queries"],
    [/\b(?:create|process|charge|reserve|refund) payment\b/, "processing payments"],
    [/\b(?:post|reserve|rollback|update) ledger\b/, "managing ledger entries"],
    [/\b(?:create|process|fulfill) order\b/, "processing orders"],
    [/\b(?:authenticate|authorize|verify token)\b/, "authenticating or authorizing requests"],
  ];
  const workflows = workflowNames.flatMap(([pattern, label]) => {
    const match = supported.find(({ entity }) => pattern.test(words(entity.name)));
    return match ? [{ ...match, label }] : [];
  });
  const selected = (workflows.length >= 2 ? workflows : activities.length ? activities : supported).slice(0, 5);
  const statements: SourceOverviewOutput["statements"] = [];
  const labels = new Set(workflows.map((workflow) => workflow.label));
  const purpose = labels.has("indexing source repositories") && (labels.has("handling conversational queries") || labels.has("extracting concepts from code"))
    ? `This appears to be ${labels.has("handling conversational queries") ? "an interactive" : "a"} source-code analysis system. `
    : labels.has("processing payments") && labels.has("managing ledger entries")
      ? "This appears to implement payment processing and ledger bookkeeping. " : "";
  if (selected.length) statements.push({
    text: `${purpose}The implemented workflows include ${selected.slice(0, 4).map((item) => "label" in item ? item.label : words(item.entity.name.split(/[.#]/).at(-1) ?? item.entity.name)).join(", ")}.`,
    entityIds: selected.slice(0, 4).map(({ entity }) => entity.entityId),
    evidenceIds: [...new Set(selected.slice(0, 4).flatMap(({ evidenceIds }) => evidenceIds))].slice(0, 20),
  });
  for (const item of selected.slice(0, 4)) {
    const { entity, evidenceIds } = item;
    const workflowLabel = "label" in item && typeof item.label === "string" ? item.label : undefined;
    const outgoing = bundle.relationships.filter((rel) => rel.kind === "calls" && rel.from === entity.entityId && byId.has(rel.to) && rel.evidence.some((ev) => current.has(ev.id))).slice(0, 3);
    statements.push({
      text: `${workflowLabel ? `${workflowLabel[0]!.toUpperCase()}${workflowLabel.slice(1)} is implemented by ${entity.name}` : `An implementation entry is ${entity.name}`}${outgoing.length ? `, which calls ${outgoing.map((rel) => byId.get(rel.to)!.name).join(", ")}` : ""}.`,
      entityIds: [entity.entityId, ...outgoing.map((rel) => rel.to)],
      evidenceIds: [...new Set([...evidenceIds, ...outgoing.flatMap((rel) => rel.evidence.map((ev) => ev.id).filter((id) => current.has(id)))])].slice(0, 20),
    });
  }
  return { statements, limits: ["Inferred from sampled implementation and static calls; runtime behavior and business intent are not proven."] };
}
