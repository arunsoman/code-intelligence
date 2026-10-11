import { Rect, register, ExtensionCategory, type RectStyleProps } from "@antv/g6";
import type { Group } from "@antv/g";
import type { ClassCard } from "./g6-notation.ts";

/** Real compartments and separators, rather than a multiline rectangle label. */
class ClassCardNode extends Rect {
  override render(attributes: Required<RectStyleProps> = this.parsedAttributes, container: Group = this) {
    super.render({ ...attributes, label: false }, container);
    const card = (attributes as Required<RectStyleProps> & { classCard?: ClassCard }).classCard;
    if (!card) return;
    const top = -card.height / 2, left = -card.width / 2;
    const text = (name: string, value: string, x: number, y: number, size: number, fill: string, centered = false) => this.upsert(name, "text", { text: value, x, y, fontSize: size, fontFamily: "ui-monospace, monospace", fill, textAlign: centered ? "center" : "left", textBaseline: "top", lineHeight: size + 4, pointerEvents: "none" }, container);
    text("class-stereotype", card.stereotype, 0, top + 10, 12, "#94a3b8", true);
    text("class-title", card.title.join("\n"), 0, top + 30, 16, "#e5e7eb", true);
    const separator = (name: string, y: number) => this.upsert(name, "line", { x1: left, y1: y, x2: -left, y2: y, stroke: "#64748b", lineWidth: 1, pointerEvents: "none" }, container);
    const fieldTop = top + card.headerHeight, methodTop = fieldTop + card.attributeHeight;
    separator("attributes-divider", fieldTop); separator("operations-divider", methodTop);
    text("attributes-heading", "Attributes", left + 12, fieldTop + 7, 11, "#94a3b8");
    text("attributes", card.attributes.join("\n"), left + 12, fieldTop + 26, 14, "#e5e7eb");
    text("operations-heading", "Operations", left + 12, methodTop + 7, 11, "#94a3b8");
    text("operations", card.operations.join("\n"), left + 12, methodTop + 26, 14, "#e5e7eb");
    this.upsert("omitted", "text", card.omitted ? { text: `${card.omitted} more members · inspect`, x: left + 12, y: card.height / 2 - 26, fontSize: 12, fill: "#94a3b8", pointerEvents: "none" } : false, container);
  }
}

let registered = false;
export function registerG6Notation() {
  if (registered) return;
  register(ExtensionCategory.NODE, "cie-class-card", ClassCardNode);
  registered = true;
}
