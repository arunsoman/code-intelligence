import { useState } from "react";
import { createRoot } from "react-dom/client";
import { G6Canvas } from "../../src/G6Canvas.tsx";
import type { Rendered, RenderNode } from "../../src/graph.ts";
import type { ViewNode } from "@cie/schema";
import "../../src/zoom.css";

const makeNode = (id: string, role: string, notes: string[] = []): RenderNode => ({ id, label: id, role, kind: "node", members: [id], count: 1, displayMode: "FACT", tier: "RELEVANT", pos: { x: 0, y: 0 }, stale: false, node: { id, label: id, role, kind: "class", file: "fixture.ts", evidenceIds: ["fixture-evidence"], entityRefs: [id], claimIds: [], displayMode: "FACT", tier: "RELEVANT", unresolvedCalls: 0, notes } satisfies ViewNode });
const classNodes = [makeNode("Account", "uml-class", ["- balance: number", "+ debit(amount: number): void", ...Array.from({ length: 20 }, (_, i) => `+ operation${i}(value: string): void`)]), makeNode("Wallet", "uml-class", ["- walletId: string", "+ transfer(): void"]), makeNode("Payable", "uml-interface", ["+ pay(): void"]), makeNode("Balance", "uml-class", ["- value: number"]), makeNode("Repository", "uml-class")];
const classes: Rendered = { nodes: classNodes, groups: [], edges: [
  ["Wallet", "Account", "inheritance"], ["Wallet", "Payable", "realization"], ["Account", "Balance", "composition"], ["Repository", "Account", "aggregation"], ["Wallet", "Repository", "dependency"],
].map(([from, to, kind], i) => ({ id: `edge${i}`, from, to, kind, label: kind, displayMode: "FACT", count: 1, edgeIds: [`edge${i}`], evidenceIds: ["fixture-evidence"], stale: false })) };
const grid: Rendered = { ...classes, edges: [] };
const architecture: Rendered = { nodes: [{ ...makeNode("API", "component"), parent: "services" }, { ...makeNode("Ledger", "component"), parent: "services" }, { ...makeNode("Database", "component"), parent: "storage" }], groups: [{ id: "system", label: "System boundary", kind: "cluster" }, { id: "services", label: "Services", kind: "file", parent: "system" }, { id: "storage", label: "Storage", kind: "file", parent: "system" }], edges: [{ id: "api-ledger", from: "API", to: "Ledger", kind: "calls", label: "calls", displayMode: "FACT", count: 1, edgeIds: ["call"], evidenceIds: ["fixture-evidence"], stale: false }, { id: "ledger-db", from: "Ledger", to: "Database", kind: "writes", label: "writes", displayMode: "FACT", count: 1, edgeIds: ["write"], evidenceIds: ["fixture-evidence"], stale: false }] };

function Fixture() {
  const [mode, setMode] = useState("classes"), [selection, setSelection] = useState(new Set<string>()), [lastTap, setLastTap] = useState("");
  const scene = mode === "architecture" ? architecture : mode === "grid" ? grid : classes;
  return <><div><button onClick={() => setMode("classes")}>Related classes</button><button onClick={() => setMode("grid")}>Class grid</button><button onClick={() => setMode("architecture")}>Architecture</button><output aria-label="Evidence action">{lastTap}</output></div>
    <div className="stage" style={{ position: "relative", width: 1100, height: 700, marginTop: 12 }}><G6Canvas key={mode} rendered={scene} viewKey={mode} level={5} selected={selection} boxSelect={false} caption={mode} fitTick={0} chartId={mode === "architecture" ? "S1" : "S16"} semanticLevels={false}
      onTapNode={n => setLastTap(n.id)} onTapEdge={e => setLastTap(e.id)} onSelectNodes={ids => setSelection(new Set(ids))} onToggleNode={n => setSelection(s => { const next = new Set(s); next.has(n.id) ? next.delete(n.id) : next.add(n.id); return next; })} onClear={() => setSelection(new Set())} onOpenOutline={() => setLastTap("outline")} announce={text => document.title = text} />
    </div></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
