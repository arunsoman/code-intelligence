// Internal types for the concept hierarchy (plan §1). Shapes that cross the wire live in @cie/schema;
// everything here is a build-time intermediate and never stored raw.

export type LanguageSoundnessTier = "verified" | "supported" | "speculative";

/** One operation inside a function's graph. Nodes are statement-grain, folded within a basic block. */
export interface PdgNode {
  id: string;
  kind:
    | "def"        // a variable gets a value (assignment initialiser)
    | "use"        // a variable is read
    | "call"       // a call site (callee name when resolved syntactically)
    | "branch"     // a condition evaluated (guard source)
    | "return"     // a return whose value expression is captured as uses
    | "throw"      // a throw
    | "acquire"    // call whose callee name matches the acquire lexicon
    | "release"    // call whose callee name matches the release lexicon
    | "await"      // an await expression
    | "assert";    // an explicit assertion (ts AssertionExpression, or a call to assert*/expect*)
  /** Variable name for def/use, callee name for call/acquire/release. */
  name?: string;
  /** Binary operator captured on a def (`x = a - b` → "op:sub"), used by composition rules only. */
  op?: "op:add" | "op:sub" | "op:mul" | "op:div";
  /** true when the value written is a dynamic property write (key not a literal), which demotes invariants. */
  dynamicWrite?: boolean;
  /** Statement ordinal within the function (0-based, traversal order). */
  at: number;
}

export interface PdgEdge {
  from: string;
  to: string;
  kind: "flow" | "data" | "guard";
}

/** A program dependence graph for one function. Blocks fold straight-line statements; guards are
 * explicit edges so downstream matchers never re-derive control dependence. */
export interface Pdg {
  entityId: string;
  file: string;
  /** sha256 of the function's source text slice; the incremental reuse key. */
  bodyHash: string;
  /** sha256 of the folded graph (node kinds/names/edges), so structurally identical bodies share motifs. */
  graphHash: string;
  nodes: PdgNode[];
  edges: PdgEdge[];
  /** Variable -> versions produced, after local SSA numbering; only local variables are tracked. */
  locals: string[];
  truncated: boolean;
  /** Counted only when the graph was built; functions beyond the budget have no Pdg at all. */
  statements: number;
}

/** What a motif matcher found, before naming or composition. */
export interface MotifMatch {
  motif: string;
  entityId: string;
  /** Node ids involved, for evidence and for composition-rule conditions. */
  nodes: string[];
  /** Free variables the motif binds: e.g. { "var": "balance", "resource": "conn" }. */
  binds: Record<string, string>;
}

/** A concept seed: one or more motif matches, before anchoring/naming. */
export interface ConceptSeed {
  entityId: string;
  motifs: MotifMatch[];
  /** Histogram over motif ids and captured ops; the anchoring feature vector. */
  features: Record<string, number>;
  compositionRule: string | null;
  kind: string;
}

/** An architectural tree node before persistence. */
export interface ArchNodeDraft {
  id: string;
  kind: "repo" | "package" | "module" | "class" | "function";
  name: string;
  path: string;
  parent: string | null;
  memberEntityIds: string[];
  children: string[];
}

export interface NamingRequest {
  conceptId: string;
  kind: string;
  features: Record<string, number>;
  members: { entityId: string; name: string; file: string }[];
  compositionRule: string | null;
}
