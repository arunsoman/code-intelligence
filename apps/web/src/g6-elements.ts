import { Diamond, Polyline, type PolylineStyleProps, BaseNode, type BaseNodeStyleProps, Rect, register, ExtensionCategory, type RectStyleProps } from "@antv/g6";
import type { Group } from "@antv/g";
import type { Drawing } from "./g6-drawing.ts";
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

/** UML package tab belongs to the key shape, so hit testing and routing see it. */
class PackageNode extends BaseNode {
  protected override drawKeyShape(attributes: Required<BaseNodeStyleProps>, container: Group) {
    const [width, height] = this.getSize(attributes), x = -width / 2, y = -height / 2, tab = 20;
    return this.upsert("key", "path", { ...this.getKeyStyle(attributes), d: [
      ["M", x, y], ["L", x + width * .38, y], ["L", x + width * .38, y + tab],
      ["L", x + width, y + tab], ["L", x + width, y + height], ["L", x, y + height], ["Z"],
    ] }, container);
  }
}

class DrawingNode extends Rect {
  override render(attributes: Required<RectStyleProps> = this.parsedAttributes, container: Group = this) {
    super.render({ ...attributes, label: false }, container);
    const drawing = (attributes as Required<RectStyleProps> & { drawing?: Drawing }).drawing;
    drawing?.shapes.forEach((shape,i)=>this.upsert(`graphic-${i}`,shape.type,{...shape.style,pointerEvents:"none"},container));
  }
}
class ErCardNode extends Rect {
  override render(attributes: Required<RectStyleProps> = this.parsedAttributes, container: Group = this) {
    super.render({...attributes,label:false},container);
    const card=(attributes as Required<RectStyleProps> & {erCard?:{title:string;rows:string[];omitted:number}}).erCard;if(!card)return;
    const [w,h]=this.getSize(attributes);
    this.upsert("title","text",{text:card.title.length>28?card.title.slice(0,27)+"…":card.title,x:0,y:-h/2+14,fontSize:16,textBaseline:"top",textAlign:"center",fill:"#e5e7eb",pointerEvents:"none"},container);
    this.upsert("divider","line",{x1:-w/2,y1:-h/2+44,x2:w/2,y2:-h/2+44,stroke:"#64748b",pointerEvents:"none"},container);
    this.upsert("rows","text",{text:[...card.rows.map(row=>row.length>39?row.slice(0,38)+"…":row),...(card.omitted?[`${card.omitted} more fields · inspect`]:[])].join("\n"),x:-w/2+12,y:-h/2+56,fontSize:12,lineHeight:20,textBaseline:"top",fill:"#e5e7eb",pointerEvents:"none"},container);
  }
}
class StoreNode extends Rect {
  override render(attributes: Required<RectStyleProps> = this.parsedAttributes, container: Group = this) {
    super.render(attributes,container);const [w,h]=this.getSize(attributes);
    this.upsert("store-top","ellipse",{cx:0,cy:-h/2+8,rx:w/2,ry:8,fill:attributes.fill,stroke:attributes.stroke,pointerEvents:"none"},container);
  }
}
class StateNode extends Rect {
  override render(attributes: Required<RectStyleProps> = this.parsedAttributes, container: Group = this) {
    super.render(attributes,container);const [w,h]=this.getSize(attributes),role=(attributes as Required<RectStyleProps>&{notationRole?:string}).notationRole;
    this.upsert("final-border","rect",role==="lifecycle-final"?{x:-w/2+5,y:-h/2+5,width:w-10,height:h-10,radius:6,fill:"transparent",stroke:attributes.stroke,pointerEvents:"none"}:false,container);
    this.upsert("initial-marker","circle",role==="lifecycle-initial"?{cx:-w/2+12,cy:-h/2+12,r:4,fill:attributes.stroke,pointerEvents:"none"}:false,container);
  }
}
class ErLink extends Polyline {
  protected override drawLabelShape(attributes: Required<PolylineStyleProps>,container:Group) {
    super.drawLabelShape(attributes,container);
    const labels=attributes as Required<PolylineStyleProps>&{sourceCardinality?:string;targetCardinality?:string};
    const [a,b]=this.getEndpoints(attributes),length=Math.hypot(b[0]-a[0],b[1]-a[1])||1,dx=(b[0]-a[0])/length,dy=(b[1]-a[1])/length;
    for(const [name,value,point,direction] of [["source-cardinality",labels.sourceCardinality,a,1],["target-cardinality",labels.targetCardinality,b,-1]] as const) {
      const x=point[0]+dx*24*direction+(Math.abs(dx)<.2?14:0),y=point[1]+dy*24*direction-10;
      this.upsert(`${name}-background`,"rect",value?{x:x-value.length*4-4,y:y-10,width:value.length*8+8,height:20,fill:"#111827",pointerEvents:"none"}:false,container);
      this.upsert(name,"text",value?{text:value,x,y,fontSize:12,textAlign:"center",fill:"#cbd5e1",pointerEvents:"none"}:false,container);
    }
  }
}
class GatewayNode extends Diamond {
  override render(attributes = this.parsedAttributes, container: Group = this) {
    super.render(attributes,container);const [,h]=this.getSize(attributes),role=(attributes as Required<RectStyleProps>&{notationRole?:string}).notationRole;
    this.upsert("gateway-marker","text",{text:role==="gateway-and"?"+":"×",x:0,y:-h/2+14,textAlign:"center",fontSize:18,fill:attributes.stroke,pointerEvents:"none"},container);
  }
}
let registered = false;
export function registerG6Notation() {
  if (registered) return;
  register(ExtensionCategory.NODE, "cie-class-card", ClassCardNode);
  register(ExtensionCategory.NODE, "cie-package", PackageNode);
  register(ExtensionCategory.NODE, "cie-drawing", DrawingNode);
  register(ExtensionCategory.NODE, "cie-er-card", ErCardNode);
  register(ExtensionCategory.NODE, "cie-store", StoreNode);
  register(ExtensionCategory.NODE, "cie-state", StateNode);
  register(ExtensionCategory.EDGE, "cie-er-link", ErLink);
  register(ExtensionCategory.NODE, "cie-gateway", GatewayNode);
  registered = true;
}
