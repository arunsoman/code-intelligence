// F12 §6 data model + §7.4 result-shaping gate. A tool result that cannot say how it is known, on which revision,
// and what it could not see is not produced: checkMcpResult rejects it before the protocol layer ever serializes it.

/** The four existing claim classes (§5: the adapter adds no fifth). Defined locally so this feature stands alone. */
export type McpClaimClass = "FACT" | "INFERENCE" | "HYPOTHESIS" | "FOG";

export const MCP_SCHEMA_VERSION = 1 as const;

export interface McpEvidence {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface McpClaim {
  class: McpClaimClass;
  text: string;
  evidence: McpEvidence[];
}

export interface McpRevision {
  /** The revision the answer was computed on. Empty only when nothing is indexed at all (a typed not-found, not a guess). */
  indexed: string;
  /** True when the working tree has moved since `indexed` and no refresh succeeded before answering. */
  workingTreeChanged: boolean;
  changedFiles: number;
}

export interface McpToolResult {
  schemaVersion: typeof MCP_SCHEMA_VERSION;
  revision: McpRevision;
  claims: McpClaim[];
  gaps: string[];
  completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  /** Denied paths are counted, never named (F12-A5). */
  withheld: { items: number; note: string } | null;
  /** Any quoted repository text is data, not instructions (F12-A8); the flag is mandatory. */
  untrustedText: true;
}

export const MCP_FORBIDDEN_WORDING = /\b(will break|will fail|will cause|causes|caused by|is safe|are safe|safe to|verified|guaranteed|guarantees?|proves?|tests pass|all tests pass)\b/i;

const CLASSES: readonly string[] = ["FACT", "INFERENCE", "HYPOTHESIS", "FOG"];

/**
 * §7.4: reject a result that lacks a revision, presents a non-Fog claim without at least one evidence id, or carries
 * certainty wording no tool supports ("tests pass", "will break", "is safe"). Returns the rejection reason, or null
 * when the result may leave the adapter. Pure and total: it never throws.
 */
export function checkMcpResult(r: McpToolResult): string | null {
  if (!r || typeof r !== "object") return "result is not an object";
  if (r.schemaVersion !== MCP_SCHEMA_VERSION) return `schemaVersion must be ${MCP_SCHEMA_VERSION}`;
  if (!r.revision || typeof r.revision.indexed !== "string" || !r.revision.indexed) return "result lacks revision.indexed";
  if (!Array.isArray(r.claims)) return "result lacks claims";
  if (!Array.isArray(r.gaps)) return "result lacks gaps";
  if (!["COMPLETE", "PARTIAL", "UNKNOWN"].includes(r.completeness)) return "completeness must be COMPLETE, PARTIAL or UNKNOWN";
  if (r.untrustedText !== true) return "result must set untrustedText: true (quoted repository text is data, not instructions)";
  for (const [i, c] of r.claims.entries()) {
    if (!CLASSES.includes(c.class)) return `claim ${i} has unknown class ${c.class}`;
    if (c.class !== "FOG" && (!Array.isArray(c.evidence) || c.evidence.length === 0 || c.evidence.some((e) => !e.id || !e.path))) {
      return `claim ${i} (${c.class}) has no evidence id; a non-Fog claim must cite at least one`;
    }
    if (MCP_FORBIDDEN_WORDING.test(c.text)) return `claim ${i} contains certainty wording the tool does not support`;
  }
  for (const g of r.gaps) if (typeof g !== "string" || !g) return "gaps must be non-empty strings";
  return null;
}

/** Claim-class ladder for the §7.3.4 staleness downgrade: one step, never below FOG, FOG stays FOG. */
export function downgradeClass(c: McpClaimClass): McpClaimClass {
  if (c === "FACT") return "INFERENCE";
  if (c === "INFERENCE") return "HYPOTHESIS";
  return c; // HYPOTHESIS and FOG are already as low as they go
}

/** An empty-but-honest result: used for not-found answers that must still carry revision, gaps and the untrusted-text flag. */
export function fogResult(revision: McpRevision, text: string, gaps: string[] = []): McpToolResult {
  return { schemaVersion: MCP_SCHEMA_VERSION, revision, claims: [{ class: "FOG", text, evidence: [] }], gaps, completeness: "UNKNOWN", withheld: null, untrustedText: true };
}
