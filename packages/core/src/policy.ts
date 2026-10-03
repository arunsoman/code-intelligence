// C03 slice: secret scrubbing and egress approval for hosted models.
// Policy: nothing is sent to a hosted model unless the repository was explicitly opted in, and anything that
// looks like a credential is removed first. Removal (not masking) keeps evidence ids and grounding intact.
import { createHash } from "node:crypto";
import type { EvidenceBundle } from "@cie/schema";

// Patterns with a recognizable shape are checked against the whole text.
const SHAPED: [string, RegExp][] = [
  ["aws-access-key", /AKIA[0-9A-Z]{16}/],
  ["github-token", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["slack-token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["api-key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
];
// Long opaque runs are checked per token, so a long file path (which is made of short words) is not mistaken for a key.
const OPAQUE: [string, RegExp][] = [
  ["long-hex", /^[0-9a-f]{40,}$/i],
  ["long-base64", /^[A-Za-z0-9+_-]{48,}={0,2}$/],
];
const SEPARATORS = /[\s/\\:#.,;()'"=<>[\]{}|]+/;

export function detectSecret(text: string): string | null {
  for (const [kind, re] of SHAPED) if (re.test(text)) return kind;
  for (const token of text.split(SEPARATORS)) for (const [kind, re] of OPAQUE) if (re.test(token)) return kind;
  return null;
}

/** Facts that exist for local ranking only. They hold author names, commit ids and messages, so they never leave the machine. */
export const LOCAL_ONLY_PREDICATES = new Set(["history"]);

export interface ScrubReport { bundle: EvidenceBundle; removed: { what: string; kind: string }[]; minimized: number }

export function scrubBundle(b: EvidenceBundle): ScrubReport {
  const removed: ScrubReport["removed"] = [];
  const badEntities = new Set<string>();
  for (const e of b.entities) {
    const kind = detectSecret(e.entityId) ?? detectSecret(e.name) ?? detectSecret(e.file);
    if (kind) { badEntities.add(e.entityId); removed.push({ what: "entity", kind }); }
  }
  const factText = (f: EvidenceBundle["facts"][number]) => JSON.stringify(f.object);
  let minimized = 0;
  const facts = b.facts.filter((f) => {
    if (LOCAL_ONLY_PREDICATES.has(f.predicate)) { minimized++; return false; }
    const kind = detectSecret(factText(f)) ?? (badEntities.has(f.subject) ? "subject-removed" : null);
    if (kind) removed.push({ what: `fact:${f.predicate}`, kind });
    return !kind;
  });
  const relationships = b.relationships.filter((r) => {
    const hit = badEntities.has(r.from) || badEntities.has(r.to) || (r.label ? detectSecret(r.label) : null);
    if (hit) removed.push({ what: `relationship:${r.kind}`, kind: "endpoint-removed" });
    return !hit;
  });
  const keptEv = new Set([...relationships.flatMap((r) => r.evidence.map((e) => e.id)), ...facts.flatMap((f) => f.evidence.map((e) => e.id))]);
  return {
    removed, minimized,
    bundle: { ...b, entities: b.entities.filter((e) => !badEntities.has(e.entityId)), facts, relationships, evidence: b.evidence.filter((e) => keptEv.has(e.id)) },
  };
}

/** What a hosted model would receive, hashed for the audit trail (never the content itself). */
export function payloadHash(b: EvidenceBundle): string {
  return createHash("sha256").update(JSON.stringify({ e: b.entities.map((x) => x.entityId), r: b.relationships.map((x) => x.id), f: b.facts.map((x) => x.id) })).digest("hex");
}

export const EGRESS_FIELDS = ["entity names", "file paths", "relationship kinds", "behavioral facts (throws, writes, transactions, topics)"] as const;
