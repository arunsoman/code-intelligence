// Task 2.K — known-source provenance record (PF-047). For every file the candidate adds or modifies: who produced it (model
// invocations or a person), and whether the text it introduces carries a licence or copyright marker that says it came from
// somewhere else. There is no offline similarity database, so copied code WITHOUT a marker is not detected; the record states
// that coverage limit instead of implying a clean bill.
import { asSet, canonHash, defineSchema, type Canon } from "./canon.ts";
import { introducedLines, type Finding, type SecurityPolicy } from "./security.ts";
import type { Hash, Id } from "./types.ts";

export interface ProvenanceFile { path: string; kind: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED"; origin: "MODEL" | "HUMAN" | "MIXED"; invocationIds: Id[]; licenceMarkers: string[]; spdx: string[] }
export interface ProvenanceRecord {
  schemaVersion: 1; bindingHash: Hash; files: ProvenanceFile[]; dependencies: { name: string; version: string; source: "REGISTRY" | "OTHER"; resolved?: string }[];
  findings: Finding[]; coverage: { markers: "CHECKED"; similarity: "NOT_CONFIGURED" | "CONFIGURED" }; hash: Hash;
}

const COPYLEFT = /\b(?:GPL|AGPL|LGPL|SSPL|EUPL|MPL|CC-BY-SA|CDDL|EPL)\b/i;
const MARKERS: [RegExp, string][] = [
  [/SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+(?:\s+(?:OR|AND|WITH)\s+[A-Za-z0-9.+-]+)*)/, "spdx"],
  [/\bCopyright\s*(?:\(c\)|©)\s*(?:\d{4}(?:\s*[-,]\s*\d{4})*\s+)?([A-Za-z][^\n*]{2,60})/i, "copyright"],
  [/\bLicen[sc]ed under the ([A-Za-z0-9 .,-]{3,60}?)(?: [Ll]icen[sc]e| ,|\.|$)/, "licence"],
  [/\bThis (?:file|program|software) is (?:free software|part of)\b[^\n]{0,80}/i, "notice"],
];
const ProvSchema = defineSchema<Omit<ProvenanceRecord, "hash">>("pf.Provenance", "1", (p) => ({
  bindingHash: p.bindingHash, similarity: p.coverage.similarity,
  files: asSet(p.files.map((f): Canon => ({ path: f.path, kind: f.kind, origin: f.origin, invocationIds: asSet(f.invocationIds), licenceMarkers: asSet(f.licenceMarkers), spdx: asSet(f.spdx) }))) as Canon,
  dependencies: asSet(p.dependencies.map((d): Canon => ({ name: d.name, version: d.version, source: d.source, resolved: d.resolved ?? "" }))) as Canon,
  findings: asSet(p.findings.map((f): Canon => ({ id: f.id, rule: f.rule, severity: f.severity }))) as Canon,
}));

export interface ProvenanceInput {
  bindingHash: Hash; invocationIds: Id[]; policy: SecurityPolicy;
  files: { path: string; kind: ProvenanceFile["kind"]; text: string | null; base: string | null; humanEdit?: boolean }[];
  dependencies: ProvenanceRecord["dependencies"]; similarityConfigured?: boolean;
}

export function buildProvenance(i: ProvenanceInput): ProvenanceRecord {
  const findings: Finding[] = []; const files: ProvenanceFile[] = [];
  for (const f of i.files) {
    const markers: string[] = [], spdx: string[] = [];
    if (f.text !== null) {
      const added = introducedLines(f.text, f.base); const lines = f.text.split("\n");
      lines.forEach((line, idx) => {
        if (!added.has(idx + 1) || line.length > 2000) return;
        for (const [re, name] of MARKERS) {
          const m = re.exec(line); if (!m) continue;
          const text = (m[1] ?? m[0]).trim().slice(0, 80);
          markers.push(`${name}: ${text}`); if (name === "spdx") spdx.push(text);
          const copyleft = COPYLEFT.test(text) || COPYLEFT.test(line);
          const own = f.kind === "MODIFIED" && f.base !== null && f.base.includes(m[0]);
          if (own) continue;
          findings.push({ id: `PROV:${f.path}:${idx + 1}:${name}`, rule: copyleft ? "PROV001" : "PROV002", cls: "PROVENANCE", severity: copyleft ? "HIGH" : "MEDIUM", path: f.path, line: idx + 1,
            message: copyleft ? `new text carries a copyleft licence marker (${text}); it may have been copied from another project` : `new text carries a ${name} marker (${text}); check where it came from`, excerpt: text, origin: "BUILTIN", introduced: true });
        }
      });
    }
    files.push({ path: f.path, kind: f.kind, origin: i.invocationIds.length ? (f.humanEdit ? "MIXED" : "MODEL") : "HUMAN", invocationIds: i.invocationIds, licenceMarkers: [...new Set(markers)].sort(), spdx: [...new Set(spdx)].sort() });
  }
  const body = { schemaVersion: 1 as const, bindingHash: i.bindingHash, files: files.sort((a, b) => a.path.localeCompare(b.path)), dependencies: [...i.dependencies].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)), findings,
    coverage: { markers: "CHECKED" as const, similarity: i.similarityConfigured ? "CONFIGURED" as const : "NOT_CONFIGURED" as const } };
  return { ...body, hash: canonHash(ProvSchema, body) };
}
