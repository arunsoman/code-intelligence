// Joins 1.G (what the model proposed) to 1.E (what can become a candidate). The model's edit plan quotes text it was shown;
// here that quoted text is turned into byte-exact edits against the same bytes, and the candidate engine then re-checks every one.
import type { FeatureEdit } from "./candidate.ts";
import { FeatureError } from "./errors.ts";
import type { ContextArtifact, PlannedEdit } from "./model.ts";

export function toFeatureEdits(edits: readonly PlannedEdit[], context: readonly ContextArtifact[]): FeatureEdit[] {
  return edits.map((e): FeatureEdit => {
    const requirementIds = [...e.requirementIds];
    if (e.kind === "CREATE_FILE") return { op: "CREATE_FILE", file: e.path, content: e.replacement, why: "generated edit", requirementIds };
    const file = context.find((c) => c.ref.locator === e.path && c.ref.contentHash === e.baseHash);
    if (!file) throw new FeatureError("STALE_REVISION", `the plan edits ${e.path}, which was not in the supplied context at that hash`);
    if (e.kind === "DELETE_FILE") return { op: "DELETE_FILE", file: e.path, baseHash: e.baseHash, why: "generated edit", requirementIds };
    const at = file.text.indexOf(e.expected);
    if (at < 0 || at !== file.text.lastIndexOf(e.expected) || !e.expected) throw new FeatureError("INVALID_SCHEMA", `the quoted text in ${e.path} is missing or ambiguous`);
    const start = Buffer.byteLength(file.text.slice(0, at));
    return { op: "REPLACE_SPAN", file: e.path, baseHash: e.baseHash, start, end: start + Buffer.byteLength(e.expected), expected: e.expected, newText: e.replacement, why: "generated edit", requirementIds };
  });
}
