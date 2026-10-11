import type { RenderEdge, RenderNode } from "./graph.ts";
import { wrapSequenceText } from "./sequence-layout.ts";

export interface ClassCard { stereotype: string; title: string[]; attributes: string[]; operations: string[]; omitted: number; width: number; height: number; headerHeight: number; attributeHeight: number }
export const isClassCard = (n: RenderNode) => ["uml-class", "uml-abstract", "uml-interface", "uml-enum"].includes(n.role ?? "");

/** Compartments follow compiler metadata; absent members are not invented. */
export function classCard(n: RenderNode): ClassCard {
  const notes = n.node?.notes ?? [], allFields = notes.filter(note => !note.startsWith("+ ")), allMethods = notes.filter(note => note.startsWith("+ "));
  const fields = allFields.slice(0, allMethods.length ? 6 : 12), methods = allMethods.slice(0, allFields.length ? 6 : 12);
  const wrap = (value: string, width: number) => { const all = wrapSequenceText(value, width); return all.length <= 3 ? all : [...all.slice(0, 2), all[2].slice(0, width - 1) + "…"]; };
  const lines = (items: string[], empty: string) => items.length ? items.flatMap(s => wrap(s, 32)) : [empty];
  const title = wrap(n.label, 28);
  const attributes = lines(fields, "No evidenced attributes"), operations = lines(methods, "No evidenced operations");
  const omitted = notes.length - fields.length - methods.length;
  const headerHeight = 34 + title.length * 20, attributeHeight = 30 + attributes.length * 18;
  return { stereotype: n.role === "uml-interface" ? "«interface»" : n.role === "uml-abstract" ? "«abstract»" : n.role === "uml-enum" ? "«enumeration»" : "«class»", title, attributes, operations, omitted, width: 300, headerHeight, attributeHeight,
    height: headerHeight + attributeHeight + 30 + operations.length * 18 + (omitted ? 22 : 0) + 12 };
}

export function g6NodeSize(n: RenderNode): [number, number] {
  if (isClassCard(n)) { const card = classCard(n); return [card.width, card.height]; }
  if (n.role === "c4-system") return [280, 96];
  if (n.role === "c4-person") return [220, 90];
  return [220, 70];
}

/** UML arrowheads encode relationship meaning independently of evidence color. */
export function g6EdgeNotation(e: RenderEdge) {
  const color = e.displayMode === "HYPOTHESIS" ? "#fb7185" : e.displayMode === "INFERENCE" ? "#a78bfa" : "#94a3b8";
  const hollow = "#111827";
  const base = { startArrow: false, endArrow: true, endArrowType: "triangle" as const, endArrowSize: 18, endArrowLineWidth: 1.5, startArrowSize: 14, stroke: color, endArrowStroke: color, startArrowStroke: color,
    lineDash: e.displayMode !== "FACT" || e.kind?.includes("dependency") ? [5, 4] : [], startArrowFill: color, endArrowFill: color };
  if (e.kind === "inheritance" || e.kind === "realization") return { ...base, endArrowFill: hollow, lineDash: e.kind === "realization" ? [6, 4] : base.lineDash };
  if (e.kind === "aggregation" || e.kind === "composition") return { ...base, startArrow: true, startArrowType: "diamond" as const, endArrow: false, startArrowFill: e.kind === "aggregation" ? hollow : color };
  if (e.kind === "dependency" || e.kind === "package-dependency") return { ...base, endArrowType: "simple" as const, lineDash: [6, 4] };
  if (e.kind === "association") return { ...base, endArrow: false };
  return base;
}

export function g6LensNotation(e: RenderEdge) {
  const notation = g6EdgeNotation(e);
  return { color: notation.stroke, sourceArrow: notation.startArrow ? "diamond" : "none", targetArrow: notation.endArrow ? notation.endArrowType === "simple" ? "vee" : "triangle" : "none", sourceArrowFill: notation.startArrowFill === "#111827" ? "hollow" : "filled", arrowFill: notation.endArrowFill === "#111827" ? "hollow" : "filled", dashed: notation.lineDash.length > 0 };
}
