import { layoutDeadline } from "./layout-deadline.ts";
import { TableCanvas } from "./TableCanvas.tsx";
import { SequenceCanvas } from "./SequenceCanvas.tsx";
import { RaceCanvas } from "./RaceCanvas.tsx";
import cytoscape from "cytoscape";
import ElkConstructor from "elkjs/lib/elk-api.js";
import type { ELK as ElkEngine, ELKConstructorArguments } from "elkjs/lib/elk-api.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import { arrangeElk, usesElk } from "./arrange.ts";
import { useEffect, useRef, useState } from "react";
import { describeNode, nextByDirection, viaToSegments, type Dir, type RenderEdge, type RenderNode, type Rendered } from "./graph.ts";
import type { OverlayMark } from "./mapoverlays.ts";
import { POLICY, fontPx, planTransition, readableFitZoom, visibility } from "./legibility.ts";
import { detailPolicyFor, type DetailPolicy, type SemanticAnchor } from "./detail.ts";
import { renderedLevelFromGraph } from "./rendered-level.ts";
import { attachFisheye, chartColor, chartFill, CHART_THEME, LENS_DEFAULTS, type LensEngine, type LensState } from "./fisheye.ts";
import "./zoom.css";
import type { CanvasState } from "./response-workspace.ts";

export interface CanvasProps {
  initialState?: CanvasState;
  onState?: (state: CanvasState) => void;
  rendered: Rendered;
  lensDetails?: Rendered;
  replayNodes?: Map<string, boolean>;
  overlayNodes?: Map<string, OverlayMark>;
  /** Changes when a new view (or new view version) replaces the old one; only then is the camera fitted. */
  viewKey: string;
  level: number;
  selected: Set<string>; // render-node ids
  boxSelect: boolean;
  onSelectNodes: (renderNodeIds: string[]) => void;
  onTapNode: (n: RenderNode) => void;
  onTapEdge: (e: RenderEdge) => void;
  caption: string;
  /** Bumps when the level was chosen explicitly (context selector); the camera then fits the new rendering. */
  fitTick: number;
  formId?: string;
  chartId?: string;
  policy?: DetailPolicy;
  onToggleNode: (n: RenderNode) => void;
  /** True for forms whose levels change the content (the semantic map); the others keep one drawing and only hide labels that are too small to read. */
  semanticLevels: boolean;
  onClear: () => void;
  onOpenOutline: () => void;
  announce: (text: string) => void;
}

// elkjs publishes a CommonJS constructor; NodeNext treats its default declaration as a module namespace.
const ELK = ElkConstructor as unknown as { new(options?: ELKConstructorArguments): ElkEngine };
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function style(): cytoscape.StylesheetJson {
  const heatCool = css("--heat-cool"), heatHot = css("--heat-hot"), fact = "#60a5fa", inf = "#a78bfa", fog = "#94a3b8", hyp = "#fb7185", warn = "#fbbf24", ok = "#4ade80", ink = CHART_THEME.text, muted = CHART_THEME.muted, panel = CHART_THEME.panel, accent = CHART_THEME.accent;
  return [
    { selector: "node", style: { label: "data(label)", "min-zoomed-font-size": POLICY.hardMinPx, "font-size": 11, color: ink, "text-valign": "center", "text-halign": "center", "text-wrap": "wrap", "text-max-width": "146px", "text-background-color": panel, "text-background-opacity": 0.9, "text-background-padding": "2px", width: 150, height: 28, shape: "round-rectangle", "background-color": panel, "border-width": 2, "border-color": fact } },
    { selector: "node[lensColor]", style: { "background-color": "data(lensFill)", "background-opacity": 1, "border-color": "data(lensColor)", "underlay-color": "data(lensColor)", "underlay-opacity": .08, "underlay-padding": 5 } },
    { selector: "node.lens-hover", style: { "underlay-opacity": .3, "underlay-padding": 10 } },
    { selector: "node[tier = 'CRITICAL']", style: { "border-width": 3, "font-weight": 700 } },
    { selector: "node[tier = 'CONTEXT']", style: { opacity: 0.8, "border-width": 1 } },
    { selector: "node[display = 'INFERENCE']", style: { "border-style": "dashed", "border-color": inf } },
    { selector: "node[display = 'HYPOTHESIS']", style: { "border-style": "dotted", "border-color": hyp, "border-width": 3 } },
    { selector: "node[display = 'FOG']", style: { "border-style": "double", "border-width": 4, "border-color": fog } },
    { selector: "node[role = 'failure-site']", style: { shape: "octagon", width: 170, height: 40, "background-color": panel, "border-color": warn } },
    { selector: "node[role = 'failure-site'][display = 'HYPOTHESIS']", style: { "border-color": hyp } },
    { selector: "node[role = 'symptom']", style: { shape: "hexagon", width: 190, height: 46, "border-width": 4, "border-color": warn, "font-weight": 700, "text-max-width": "170px" } },
    { selector: "node[role = 'state']", style: { shape: "barrel", width: 130, height: 44, "border-width": 4, "font-weight": 700 } },
    { selector: "node[kind = 'ext']", style: { shape: "tag", width: 150, height: 30, "border-style": "dashed", "border-color": muted, color: muted, "background-opacity": 0.5 } },
    { selector: "node[group = 'cluster']", style: { "border-style": "dashed", "border-width": 2, "border-color": inf, "background-color": inf, "background-opacity": 0.04, "font-size": 13, "font-weight": 700, color: inf, padding: "22px" } },
    // Heat: a value 0..1 tints the node from cool to hot (risk, attention, thin knowledge). The words explaining it are in the drawer.
    { selector: "node[heatv >= 0][kind = 'node']", style: { "background-color": `mapData(heatv, 0, 1, ${heatCool}, ${heatHot})` } as never },
    { selector: "node[hasBadge = 1][kind = 'node']", style: { height: 44, "text-wrap": "wrap", "font-size": 10 } },
    { selector: "node[ghost = 1]", style: { "border-style": "dashed", "border-color": hyp, opacity: 0.8, "background-opacity": 0.35 } },
    { selector: "node[inTx = 1]", style: { "border-style": "double", "border-width": 5 } },
    { selector: "node[role = 'gate'], node[role = 'policy']", style: { shape: "diamond", width: 150, height: 64, "text-max-width": "110px" } },
    { selector: "node[role = 'decision']", style: { shape: "diamond", width: 150, height: 54, "border-color": warn, "text-max-width": "110px" } },
    { selector: "node[role = 'hazard'], node[role = 'race'], node[role = 'unprotected'], node[role = 'consequence'], node[role = 'gap']", style: { shape: "octagon", width: 160, height: 44, "border-color": hyp, "border-width": 3, "border-style": "dashed" } },
    { selector: "node[role = 'event'], node[role = 'commit']", style: { shape: "ellipse", width: 190, height: 52, "text-max-width": "160px" } },
    { selector: "node[role = 'constraint']", style: { shape: "round-tag", width: 190, height: 52, "border-style": "dashed", "text-max-width": "160px" } },
    { selector: "node[role = 'test']", style: { shape: "cut-rectangle", "border-color": ok } },
    { selector: "node[role = 'behavior'], node[role = 'concept']", style: { shape: "round-rectangle", width: 200, height: 52, "border-width": 4, "font-weight": 700, "text-max-width": "180px" } },
    { selector: "node[role = 'external']", style: { shape: "tag" } },
    // ── Chart notation roles (S1–S15): shape and line style carry the notation, not color alone ──
    { selector: "node[role = 'table']", style: { shape: "round-rectangle", width: 210, height: 56, "border-width": 3, "font-weight": 700, "text-max-width": "190px", "text-valign": "center" } },
    { selector: "node[role = 'start-event']", style: { shape: "ellipse", width: 90, height: 40, "border-width": 4 } },
    { selector: "node[role = 'end-event']", style: { shape: "ellipse", width: 90, height: 40, "border-width": 6 } },
    { selector: "node[role = 'intermediate-event']", style: { shape: "ellipse", width: 110, height: 42, "border-style": "dashed", "border-width": 3 } },
    { selector: "node[role = 'gateway-xor']", style: { shape: "diamond", width: 110, height: 54, "border-width": 3, "text-max-width": "90px" } },
    { selector: "node[role = 'gateway-and']", style: { shape: "diamond", width: 110, height: 54, "border-width": 6, "text-max-width": "90px" } },
    { selector: "node[role = 'task']", style: { shape: "round-rectangle", width: 170, height: 44 } },
    { selector: "node[role = 'compensation-task'], node[role = 'compensation-step']", style: { shape: "round-rectangle", width: 170, height: 44, "border-style": "dashed", "border-color": inf, "border-width": 3 } },
    { selector: "node[role = 'forward-step'], node[role = 'retry-step']", style: { shape: "round-rectangle", width: 170, height: 44, "border-width": 3 } },
    { selector: "node[role = 'command']", style: { shape: "round-tag", width: 170, height: 44, "font-weight": 700 } },
    { selector: "node[role = 'domain-event']", style: { shape: "ellipse", width: 180, height: 50, "text-max-width": "160px" } },
    { selector: "node[role = 'policy']", style: { shape: "diamond", width: 150, height: 60, "text-max-width": "110px" } },
    { selector: "node[role = 'aggregate']", style: { shape: "round-rectangle", width: 180, height: 50, "border-width": 5, "font-weight": 700 } },
    { selector: "node[role = 'read-model']", style: { shape: "rhomboid", width: 180, height: 46 } },
    { selector: "node[role = 'external-system'], node[role = 'external-entity']", style: { shape: "tag", width: 160, height: 36, "border-style": "dashed", "border-color": muted } },
    { selector: "node[role = 'process']", style: { shape: "ellipse", width: 170, height: 56, "text-max-width": "140px" } },
    { selector: "node[role = 'data-store']", style: { shape: "barrel", width: 150, height: 48 } },
    { selector: "node[role = 'writer'], node[role = 'poller'], node[role = 'consumer']", style: { shape: "round-rectangle", width: 170, height: 44, "border-width": 3 } },
    { selector: "node[role = 'outbox-store']", style: { shape: "barrel", width: 150, height: 48, "border-width": 4 } },
    { selector: "node[role = 'dead-letter']", style: { shape: "octagon", width: 150, height: 44, "border-style": "dashed", "border-color": hyp, "border-width": 3 } },
    { selector: "node[role = 'interface']", style: { shape: "round-tag", width: 170, height: 44, "border-color": inf } },
    { selector: "node[role = 'factory']", style: { shape: "cut-rectangle", width: 170, height: 44 } },
    { selector: "node[role = 'rule'], node[role = 'operation']", style: { shape: "round-tag", width: 170, height: 44 } },
    // ── Chart notation roles (S16–S28): shape and line style carry the notation, not color alone ──
    { selector: "node[role ^= 'activity-']", style: { shape: "round-rectangle", width: 220, height: 72, "text-wrap": "wrap", "text-max-width": "200px", "font-size": 12, "border-width": 2 } },
    { selector: "node[role = 'activity-decision']", style: { shape: "diamond", width: 240, height: 120, "text-max-width": "120px" } },
    { selector: "node[role = 'activity-event']", style: { shape: "round-tag" } },
    { selector: "node[role = 'activity-external']", style: { shape: "tag", "border-style": "dashed" } },
    { selector: "node[role = 'lifecycle-state'], node[role = 'lifecycle-initial'], node[role = 'lifecycle-final']", style: { shape: "round-rectangle", width: 220, height: 72, "text-max-width": "200px", "text-wrap": "wrap", "font-size": 12, "border-width": 2 } },
    { selector: "node[role = 'lifecycle-initial']", style: { "border-width": 4 } },
    { selector: "node[role = 'lifecycle-final']", style: { "border-style": "double", "border-width": 6 } },
    { selector: "node[role = 'er-entity']", style: { shape: "round-rectangle", width: 320, height: "mapData(erRows, 0, 13, 68, 328)", "border-width": 2, "text-wrap": "wrap", "text-max-width": "296px", "font-size": 12, "text-valign": "center" } },
    { selector: "node[role = 'uml-class'], node[role = 'uml-abstract'], node[role = 'uml-interface']", style: { shape: "round-rectangle", width: 270, height: "mapData(umlLines, 1, 10, 76, 238)", "border-width": 3, "font-weight": 700, "text-max-width": "246px", "font-size": 10, "text-valign": "center" } },
    { selector: "node[role = 'uml-abstract']", style: { "border-style": "dashed" } },
    { selector: "node[role = 'uml-interface']", style: { "border-style": "double" } },
    { selector: "node[role = 'uml-enum']", style: { shape: "round-rectangle", width: 270, height: "mapData(umlLines, 1, 10, 76, 238)", "border-width": 3, "text-max-width": "246px", "font-size": 10, "text-valign": "center" } },
    { selector: "node[role = 'package']", style: { shape: "round-tag", width: 180, height: 46, "border-width": 3, "text-max-width": "160px" } },
    { selector: "node[role = 'module'], node[role = 'crate']", style: { shape: "round-rectangle", width: 170, height: 44, "border-width": 2, "border-style": "dashed" } },
    { selector: "node[role = 'participant'], node[role = 'component']", style: { shape: "round-rectangle", width: 180, height: 46, "border-width": 3, "font-weight": 700 } },
    { selector: "node[role = 'lifeline']", style: { shape: "ellipse", width: 130, height: 36, "border-width": 4, "font-weight": 700 } },
    { selector: "node[role = 'message'], node[role = 'async-message'], node[role = 'return-message']", style: { shape: "round-tag", width: 190, height: 40, "font-size": 10, "text-max-width": "180px" } },
    { selector: "node[role = 'async-message'], node[role = 'return-message']", style: { "border-style": "dashed" } },
    { selector: "node[role = 'interaction-ref']", style: { shape: "round-rectangle", width: 190, height: 50, "border-width": 5, "text-max-width": "170px" } },
    { selector: "node[role = 'crc-card']", style: { shape: "cut-rectangle", width: 200, height: 52, "border-width": 3, "font-weight": 700, "text-max-width": "180px" } },
    { selector: "node[role = 'function'], node[role = 'method']", style: { shape: "round-rectangle", width: 170, height: 42 } },
    { selector: "node[role = 'method']", style: { "border-style": "dotted", "border-width": 2 } },
    { selector: "node[role = 'failure-mode']", style: { shape: "octagon", width: 180, height: 46, "border-color": warn, "border-width": 3 } },
    { selector: "node[role = 'metric']", style: { shape: "round-tag", width: 190, height: 44 } },
    { selector: "node[role = 'c4-person']", style: { shape: "ellipse", width: 170, height: 46, "border-width": 3, "font-weight": 700 } },
    { selector: "node[role = 'c4-system']", style: { shape: "round-rectangle", width: 220, height: 60, "border-width": 5, "font-weight": 700, "text-max-width": "200px" } },
    { selector: "node[group = 'lane']", style: { "border-style": "solid", "border-width": 1, "border-color": muted, "background-opacity": 0.05, "text-halign": "left", "text-valign": "top", "font-size": 12, "font-weight": 700, color: ink, padding: "26px" } },
    { selector: "node[group = 'region']", style: { "border-style": "solid", "border-width": 3, "border-color": ink, "background-opacity": 0.04, "font-size": 12, "font-weight": 700, color: ink, padding: "30px" } },
    { selector: "edge[ghost = 1]", style: { "line-style": "dashed", opacity: 0.6, "line-color": muted, "target-arrow-color": muted } },
    { selector: "edge[kind = 'escape route'], edge[kind = 'can reach'], edge[kind = 'interleaves'], edge[kind = 'may-explain'][display = 'HYPOTHESIS']", style: { "line-color": hyp, "target-arrow-color": hyp, color: hyp } },
    { selector: "edge[ret = 1]", style: { "curve-style": "unbundled-bezier", "control-point-distances": [-60], "control-point-weights": [0.5], "line-style": "dotted" } },
    // Chart flow kinds: sequence vs message vs forbidden vs unresolved stay distinguishable in form and words.
    { selector: "edge[kind = 'message-flow']", style: { "line-style": "dashed", "target-arrow-shape": "circle" } },
    { selector: "edge[kind = 'forbidden-transition']", style: { "line-style": "dashed", "line-color": warn, "target-arrow-color": warn, "target-arrow-shape": "tee", color: warn } },
    { selector: "edge[kind = 'unresolved-binding']", style: { "line-style": "dotted", "line-color": fog, "target-arrow-color": fog } },
    { selector: "edge[kind = 'async-flow'], edge[kind = 'produces'], edge[kind = 'consumes'], edge[kind = 'reacts']", style: { "line-style": "dashed" } },
    { selector: "edge[kind = 'failure'], edge[kind = 'deadLetter']", style: { "line-color": warn, "target-arrow-color": warn, color: warn } },
    { selector: "edge[kind = 'compensation']", style: { "line-color": inf, "target-arrow-color": inf, color: inf } },
    // UML relation kinds (S16–S28): the arrowhead carries the UML meaning.
    { selector: "edge[kind = 'inheritance']", style: { "target-arrow-shape": "triangle", "target-arrow-fill": "hollow", width: 2 } },
    { selector: "edge[kind = 'realization']", style: { "line-style": "dashed", "target-arrow-shape": "triangle", "target-arrow-fill": "hollow" } },
    { selector: "edge[kind = 'dependency'], edge[kind = 'package-dependency']", style: { "line-style": "dashed", "target-arrow-shape": "vee" } },
    { selector: "edge[kind = 'aggregation']", style: { "source-arrow-shape": "diamond", "source-arrow-fill": "hollow", "source-arrow-color": fact } },
    { selector: "edge[kind = 'composition']", style: { "source-arrow-shape": "diamond", "source-arrow-fill": "filled", "source-arrow-color": fact } },
    { selector: "edge[kind = 'async-message'], edge[kind = 'return-message']", style: { "line-style": "dashed", "target-arrow-shape": "vee" } },
    { selector: "edge[kind = 'reading-order']", style: { "line-style": "dotted", "line-color": muted, "target-arrow-color": muted, "target-arrow-shape": "vee", width: 1 } },
    { selector: "node[kind = 'agg']", style: { width: 190, height: 44, "border-width": 3, "font-weight": 700, "text-max-width": "170px", "background-color": panel } },
    { selector: "node[detail = 1][kind = 'node']", style: { height: 46, "text-wrap": "wrap", "font-size": 10 } },
    // Detail mode normally shortens every node; retain the UML member compartments instead of clipping them.
    { selector: "node[detail = 1][role = 'uml-class'], node[detail = 1][role = 'uml-abstract'], node[detail = 1][role = 'uml-interface'], node[detail = 1][role = 'uml-enum']", style: { width: 270, height: "mapData(umlLines, 1, 10, 76, 238)", "text-wrap": "wrap", "text-max-width": "246px", "font-size": 10 } },
    { selector: "node[detail = 1][role ^= 'activity-']", style: { width: 220, height: 72, "text-max-width": "200px", "font-size": 12 } },
    { selector: "node[detail = 1][role = 'activity-decision']", style: { width: 240, height: 120, "text-max-width": "120px" } },
    { selector: "node[detail = 1][role ^= 'lifecycle-']", style: { width: 220, height: 72, "text-max-width": "200px", "font-size": 12 } },
    { selector: "node[detail = 1][role = 'er-entity']", style: { width: 320, height: "mapData(erRows, 0, 13, 68, 328)", "font-size": 12, "text-max-width": "296px" } },
    { selector: "edge[kind = 'er-declared'], edge[kind = 'er-inferred']", style: { "target-arrow-shape": "none", "source-arrow-shape": "none", "source-label": "data(sourceLabel)", "target-label": "data(targetLabel)", "source-text-offset": 24, "target-text-offset": 24, "source-text-rotation": "none", "target-text-rotation": "none", "font-size": 11 } },
    { selector: "edge[kind = 'er-inferred']", style: { "line-style": "dashed" } },
    { selector: "node.stale", style: { opacity: 0.45, "border-style": "dotted", "border-color": muted } },
    { selector: ":parent", style: { "text-valign": "top", "text-halign": "center", "background-opacity": 0.06, "background-color": ink, "border-width": 1, "border-style": "solid", "border-color": muted, "font-size": 11, color: muted, padding: "14px", shape: "round-rectangle", "font-weight": 400 } },
    { selector: "node[group = 'concept']", style: { "border-style": "dashed", "border-color": inf, "background-color": inf, "background-opacity": 0.06, "font-size": 12 } },
    { selector: "edge", style: { "min-zoomed-font-size": POLICY.hardMinPx, width: 2, "line-color": fact, "target-arrow-color": fact, "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 0.9, label: "data(label)", "font-size": 9, color: muted, "text-background-color": panel, "text-background-opacity": 1, "text-background-padding": "3px", "text-border-width": 1, "text-border-color": panel, "text-border-opacity": 1 } },
    { selector: "edge[display = 'INFERENCE']", style: { "line-style": "dashed", "line-color": inf, "target-arrow-color": inf, color: inf } },
    { selector: "edge[display = 'HYPOTHESIS']", style: { "line-style": "dotted", width: 3, "line-color": hyp, "target-arrow-color": hyp, color: hyp } },
    { selector: "edge[display = 'FOG']", style: { "line-style": "dotted", "line-color": fog, "target-arrow-color": fog } },
    { selector: "edge[kind = 'depends-on']", style: { "line-style": "dashed", "line-color": muted, "target-arrow-color": muted } },
    { selector: "edge[kind = 'raises']", style: { "line-color": warn, "target-arrow-color": warn, color: warn } },
    { selector: "edge[count > 1]", style: { width: "mapData(count, 2, 12, 3, 8)" } },
    { selector: "edge.stale", style: { opacity: 0.4 } },
    { selector: "edge[ambient = 1]", style: { opacity: 0.45, width: 1.5, "target-arrow-shape": "triangle", label: "" } },
    { selector: "edge.focus", style: { opacity: 1, width: 2, "target-arrow-shape": "triangle" } },
    { selector: "edge[kind = 'forbidden-transition']", style: { "line-style": "dashed", "target-arrow-shape": "tee", "line-color": warn, "target-arrow-color": warn, color: warn } },
    { selector: "edge[kind = 'replay-transition']", style: { "line-style": "dotted", "target-arrow-shape": "triangle" } },
    { selector: "node.kbfocus", style: { "overlay-color": accent, "overlay-opacity": 0.28, "overlay-padding": 9, "border-width": 4, "border-color": accent } },
    { selector: "node.replay-observed", style: { "underlay-color": accent, "underlay-opacity": 0.3, "underlay-padding": 10 } },
    { selector: "node.replay-error", style: { "underlay-color": warn, "underlay-opacity": 0.45, "underlay-padding": 12 } },
    { selector: "node[testOverlaySize]", style: { "pie-size": "100%", "pie-1-background-color": muted, "pie-1-background-size": "data(testOverlaySize)" } },
    { selector: "node[runtimeOverlaySize]", style: { "pie-2-background-color": inf, "pie-2-background-size": "data(runtimeOverlaySize)" } },
    { selector: "node.test-overlay-failing", style: { "pie-1-background-color": warn } },
    { selector: "node.runtime-overlay-errors", style: { "pie-2-background-color": warn } },
    { selector: "node.test-overlay-covered", style: { "pie-1-background-color": ok } },
    { selector: "node.test-overlay-low", style: { "pie-1-background-color": inf } },
    { selector: "node.test-overlay-linked", style: { "pie-1-background-color": accent } },
    { selector: "node.runtime-overlay-observed", style: { "pie-2-background-color": accent } },
    { selector: ":selected", style: { "overlay-color": accent, "overlay-opacity": 0.25, "overlay-padding": 6 } },
  ] as cytoscape.StylesheetJson;
}

/** Ambient edges are faint until one of their ends is selected or has keyboard focus. */
function focusEdges(c: cytoscape.Core, focusId: string | null) {
  c.batch(() => {
    c.edges().removeClass("focus");
    const ends = c.nodes(":selected");
    ends.connectedEdges().addClass("focus");
    if (focusId) c.getElementById(focusId).connectedEdges().addClass("focus");
  });
}

/**
 * Fit the whole map, never larger than 1.4. A form that can coarsen (the semantic map) is fitted whole and then moves to a
 * level whose labels are readable. A form that cannot coarsen further (a swim-lane journey has one drawing) is instead
 * raised to the readable floor, so its steps are not left at microscopic text; the off-screen notice then says what is out of view.
 */
function fitReadable(c: cytoscape.Core, readableFloor = false) {
  c.resize(); c.fit(undefined, 40);
  const fontUnits = Math.min(11, ...c.nodes().filter(n => !n.isParent()).map(n => parseFloat(n.style("font-size")) || 11));
  const z = readableFloor ? readableFitZoom(c.zoom(), 1.4, 11, fontUnits) : Math.min(c.zoom(), 1.4);
  if (z !== c.zoom()) c.zoom(z);
  c.center();
  if (readableFloor) {
    // When the readable drawing cannot fit, start at its beginning rather than
    // hiding the entry point above/left of the viewport. Pan remains available.
    const bb = c.elements().boundingBox();
    const pan = c.pan();
    c.pan({ x: bb.w * z > c.width() - 80 ? 40 - bb.x1 * z : pan.x,
      y: bb.h * z > c.height() - 120 ? 64 - bb.y1 * z : pan.y });
  }
}
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The thing the person was looking at: what is under the pointer (or near it), else the selection, else what is nearest the middle of the view. */
function captureAnchor(c: cytoscape.Core, rendered: Rendered, selected: Set<string>, pointer: { x: number; y: number } | null, focusId: string | null): { ids: string[]; screen: { x: number; y: number } } {
  const w = c.width(), h = c.height(), centre = { x: w / 2, y: h / 2 };
  const byId = new Map(rendered.nodes.map((n) => [n.id, n]));
  const nearest = (pt: { x: number; y: number }) => {
    let best: cytoscape.NodeSingular | null = null, dist = Infinity;
    c.nodes().forEach((n) => {
      if (n.isParent()) return;
      const b = n.renderedBoundingBox(), inside = pt.x >= b.x1 && pt.x <= b.x2 && pt.y >= b.y1 && pt.y <= b.y2;
      const d = inside ? 0 : Math.hypot(pt.x - (b.x1 + b.x2) / 2, pt.y - (b.y1 + b.y2) / 2);
      if (d < dist) { dist = d; best = n; }
    });
    return { node: best as cytoscape.NodeSingular | null, dist };
  };
  const preferred = [...(focusId ? [focusId] : []), ...selected].flatMap((id) => byId.get(id)?.members ?? []);
  const pt = pointer ?? centre;
  const under = nearest(pt);
  if (under.node && (pointer ? under.dist <= 80 : true) && byId.get(under.node.id())) {
    const ms = byId.get(under.node.id())!.members;
    return { ids: [...ms.filter((m) => preferred.includes(m)), ...ms.filter((m) => !preferred.includes(m))], screen: pt };
  }
  if (preferred.length) {
    const first = [...(focusId ? [focusId] : []), ...selected].map((id) => c.getElementById(id)).find((e) => !e.empty());
    const b = first?.renderedBoundingBox();
    return { ids: preferred, screen: b ? { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 } : pt };
  }
  const mid = nearest(centre);
  return { ids: mid.node ? byId.get(mid.node.id())?.members ?? [] : [], screen: centre };
}

export function Canvas(input: CanvasProps) {
  return input.rendered.race ? <RaceCanvas {...input} /> : input.rendered.table ? <TableCanvas {...input} /> : input.rendered.sequence ? <SequenceCanvas {...input} /> : <GraphCanvas {...input} />;
}

function GraphCanvas(input: CanvasProps) {
  const lens = useRef<LensEngine | null>(null);
  const [lensState, setLensState] = useState<LensState>(input.initialState?.lens ?? LENS_DEFAULTS);
  const lensStateRef = useRef(lensState); lensStateRef.current = lensState;
  const [aspect, setAspect] = useState(1);
  const [layout, setLayout] = useState<{ source: Rendered; aspect: number; result: Rendered; engine: "elk" | "fallback" } | null>(null);
  const engine = useRef<InstanceType<typeof ELK> | null>(null);
  const automatic = usesElk(input.rendered, input.formId, input.chartId);
  const layoutReady = !automatic || (layout?.source === input.rendered && layout.aspect === aspect);
  const p = { ...input, rendered: automatic && layoutReady ? layout!.result : input.rendered };
  const host = useRef<HTMLDivElement>(null);
  const cy = useRef<cytoscape.Core | null>(null);
  const cb = useRef(p);
  cb.current = p;
  const syncing = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [hint, setHint] = useState<{ off: number; total: number; labelsHidden: boolean }>({ off: 0, total: 0, labelsHidden: false });
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const lastViewKey = useRef("");
  const lastLayoutAspect = useRef(aspect);
  const focusId = useRef<string | null>(null);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!automatic) return;
    let live = true;
    const started = performance.now();
    try { engine.current ??= new ELK({ workerUrl: elkWorkerUrl }); }
    catch (error) {
      console.warn("[graph-layout] worker unavailable", error);
      setLayout({ source: input.rendered, aspect, result: input.rendered, engine: "fallback" });
      return;
    }
    const jobEngine=engine.current;
    const job=layoutDeadline(arrangeElk(input.rendered, jobEngine, {
      width: host.current?.clientWidth || 800, height: host.current?.clientHeight || 600,
    }));
    void job.promise.then((result) => {
      if (!live) return;
      console.info("[graph-layout]", { engine: "elk-layered", nodes: result.nodes.length, edges: result.edges.length, aspect, elapsedMs: Math.round(performance.now() - started) });
      setLayout({ source: input.rendered, aspect, result, engine: "elk" });
    }).catch((error) => {
      if (!live) return;
      console.warn("[graph-layout] using fallback", error);
      jobEngine.terminateWorker();if(engine.current===jobEngine)engine.current=null;
      setLayout({ source: input.rendered, aspect, result: input.rendered, engine: "fallback" });
    });
    return () => { live = false;job.cancel();jobEngine.terminateWorker();if(engine.current===jobEngine)engine.current=null; };
  }, [input.rendered, automatic, aspect]);

  useEffect(() => () => { engine.current?.terminateWorker(); engine.current = null; }, []);

  useEffect(() => {
    if (!host.current) return;
    const c = cytoscape({ container: host.current, style: style(), boxSelectionEnabled: true, userZoomingEnabled: false, wheelSensitivity: 0.25, minZoom: 0.05, maxZoom: 4 });
    cy.current = c;
    c.on("select unselect", "node", () => {
      if (syncing.current) return;
      cb.current.onSelectNodes(c.nodes(":selected").filter((n) => !n.isParent()).map((n) => n.id()));
    });
    c.on("tap", "node", (e) => { if (e.target.isParent()) return; const n = cb.current.rendered.nodes.find((x) => x.id === e.target.id()); if (n) cb.current.onTapNode(n); });
    c.on("dbltap", "node", (e) => { lens.current?.focus(e.target.renderedPosition()); });
    c.on("tap", "edge", (e) => { const ed = cb.current.rendered.edges.find((x) => x.id === e.target.id()); if (ed) cb.current.onTapEdge(ed); });
    // A wrapped or shortened label still has its full text: show it on hover, and the text outline (O) keeps every name too.
    const showTip = (e: cytoscape.EventObject, text: string | undefined) => { if (!text) return; const rp = e.target.renderedPosition(); setTip({ x: rp.x, y: rp.y - 12, text }); };
    c.on("mouseover", "node", (e) => showTip(e, cb.current.rendered.nodes.find((x) => x.id === e.target.id())?.label));
    c.on("mouseover", "edge", (e) => showTip(e, cb.current.rendered.edges.find((x) => x.id === e.target.id())?.label));
    c.on("mouseout", "node, edge", () => setTip(null));
    c.on("mouseover", "node", (e) => e.target.addClass("lens-hover"));
    c.on("mouseout", "node", (e) => e.target.removeClass("lens-hover"));
    const fisheye = attachFisheye(host.current, {
      interactive: () => !cb.current.boxSelect,
      onChange: (state) => { lensStateRef.current = state; setLensState(state); cb.current.onState?.({ zoom: c.zoom(), pan: c.pan(), lens: state }); },
      scene: () => {
        const nodes = cb.current.rendered.nodes.flatMap((n) => {
          const element = c.getElementById(n.id); if (element.empty()) return [];
          const at = element.renderedPosition();
          return [{ id: n.id, label: n.label, ref: n, ...at, width: element.renderedWidth(), height: element.renderedHeight(), color: chartColor(n.node?.file ?? n.label, n.role), shape: element.style("shape"), displayMode: n.displayMode, selected: element.selected(), details: [n.node?.kind ?? n.role ?? "", ...(n.node?.notes ?? [])].filter(Boolean) }];
        });
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const edges = cb.current.rendered.edges.flatMap((e) => {
          const a = byId.get(e.from), b = byId.get(e.to); if (!a || !b) return [];
          const z = c.zoom(), pan = c.pan(), element = c.getElementById(e.id);
          return [{ id: e.id, from: e.from, to: e.to, ref: e, sourceArrow: element.style("source-arrow-shape"), targetArrow: element.style("target-arrow-shape"), arrowFill: element.style("target-arrow-fill"), sourceArrowFill: element.style("source-arrow-fill"), lineStyle: element.style("line-style"), label: element.style("label"), color: element.style("line-color"), dashed: element.style("line-style") === "dashed", points: [a, ...(e.via ?? []).map((p) => ({ x: p.x * z + pan.x, y: p.y * z + pan.y })), b] }];
        });
        return { nodes, edges };
      },
      children: (parent) => {
        if (parent.ref?.kind !== "agg") return { nodes: [], edges: [] };
        const members = new Set(parent.ref.members), details = cb.current.lensDetails;
        return { nodes: details?.nodes.filter((n) => members.has(n.id)) ?? [], edges: details?.edges ?? [] };
      },
      onNode: (node, toggle) => { if (node.ref) { if (toggle) cb.current.onToggleNode(node.ref); else cb.current.onTapNode(node.ref); } },
      onEdge: (edge) => { if (edge.ref) cb.current.onTapEdge(edge.ref); },
    });
    lens.current = fisheye;
    fisheye.configure(cb.current.initialState?.lens ?? { easing: !window.matchMedia("(prefers-reduced-motion: reduce)").matches });
    c.on("pan zoom", () => cb.current.onState?.({ zoom: c.zoom(), pan: c.pan(), lens: lensStateRef.current }));
    c.on("render pan zoom", fisheye.refresh);
    // What the person can see: how many elements are outside the viewport, and whether labels are too small to be drawn.
    let raf = 0;
    const refresh = () => {
      raf = 0;
      const boxes = c.nodes().filter((n) => !n.isParent()).map((n) => n.renderedBoundingBox());
      const v = visibility(boxes, c.width(), c.height());
      const labelsHidden = boxes.length > 0 && fontPx(c.zoom()) < POLICY.hardMinPx;
      setHint((h) => (h.off === v.offscreen && h.total === v.total && h.labelsHidden === labelsHidden ? h : { off: v.offscreen, total: v.total, labelsHidden }));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(refresh); };
    c.on("pan zoom resize", schedule);
    refreshRef.current = refresh;
    host.current.addEventListener("wheel", (e) => { const r = host.current!.getBoundingClientRect(); pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top }; }, { passive: true, capture: true });
    // The stage can be resized after mount (caption wraps, panels resize); keep cytoscape's measurements current.
    const ro = new ResizeObserver(() => {
      c.resize();
      // Bucket the aspect ratio to avoid repeatedly laying out during a panel drag.
      const ratio = Math.max(0.25, Math.min(4, c.width() / Math.max(1, c.height())));
      setAspect(Math.round(ratio * 4) / 4);
    });
    ro.observe(host.current);
    return () => { fisheye.dispose(); lens.current = null; ro.disconnect(); if (raf) cancelAnimationFrame(raf); c.destroy(); cy.current = null; };
  }, []);

  /** "Bring into view": fit everything; labels that would be too small to read are then not drawn, and the outline keeps the names. */
  const bringIntoView = () => {
    const c = cy.current; if (!c) return;
    if (reduceMotion()) { fitReadable(c); refreshRef.current(); return; }
    c.animate({ fit: { eles: c.elements(), padding: 40 }, duration: 180, complete: () => { if (c.zoom() > 1.4) c.zoom(1.4); refreshRef.current(); } });
  };

  // Rebuild elements when the rendering changes. The camera moves only for a new view; level changes and
  // verdicts keep it exactly where the user left it (cameraPolicy PRESERVE).
  useEffect(() => {
    const c = cy.current;
    if (!c || !layoutReady) return;
    const { rendered, level } = p;
    if (p.chartId === "S16") {
      const umlNodes = rendered.nodes.filter((n) => ["uml-class", "uml-abstract", "uml-interface", "uml-enum"].includes(n.role ?? ""));
      console.info("[uml-canvas]", { viewKey: p.viewKey, level, classes: umlNodes.length, classesWithMembers: umlNodes.filter((n) => (n.node?.notes?.length ?? 0) > 0).length, members: umlNodes.reduce((sum, n) => sum + (n.node?.notes?.length ?? 0), 0) });
    }
    syncing.current = true;
    c.elements().remove();
    const nodePos = new Map(rendered.nodes.map((n) => [n.id, n.pos]));
    const els: cytoscape.ElementDefinition[] = [
      ...rendered.groups.map((g) => ({ data: { id: g.id, label: g.label, group: g.kind, parent: g.parent && rendered.groups.some((x) => x.id === g.parent) ? g.parent : undefined } })),
      ...rendered.nodes.map((n) => {
        const er = n.role === "er-entity";
        const erNotes = er ? (n.node?.notes ?? []).slice(0,12).map(note => note.length > 42 ? note.slice(0,41)+"…" : note) : [];
        const erRows = erNotes.length + ((n.node?.notes?.length ?? 0) > 12 ? 1 : 0);
        const erLabel = er ? `${n.label.length > 42 ? n.label.slice(0,41)+"…" : n.label}\n────────────────────${erNotes.length ? "\n"+erNotes.join("\n") : "\nNo evidenced columns"}${(n.node?.notes?.length ?? 0) > 12 ? `\n… ${n.node!.notes!.length-12} more fields · inspect` : ""}` : "";
        const bd = n.node?.badge;
        const uml = !!n.node && ["uml-class", "uml-abstract", "uml-interface", "uml-enum"].includes(n.role ?? "");
        const umlNotes = uml ? (n.node?.notes ?? []).slice(0, 8) : [];
        const umlKind = n.role === "uml-interface" ? "«interface»" : n.role === "uml-enum" ? "«enumeration»" : n.role === "uml-abstract" ? "«abstract»" : "«class»";
        const umlLabel = uml ? `${umlKind}\n${n.label}\n────────────────────${umlNotes.length ? `\n${umlNotes.join("\n")}` : ""}${(n.node?.notes?.length ?? 0) > umlNotes.length ? `\n… ${n.node!.notes!.length - umlNotes.length} more members` : ""}` : "";
        const detail = er ? erLabel : uml ? umlLabel : level >= 6 && n.node ? `${n.label}\n${[n.role === "symbol" ? n.node.kind : n.role, n.node.notes?.length ? `${n.node.notes.length} note(s)` : "", n.node.unresolvedCalls ? `${n.node.unresolvedCalls} unresolved calls` : ""].filter(Boolean).join(" · ")}` : n.label;
        const labelText = level === 3 && n.unresolvedCalls ? `${detail}\n${n.unresolvedCalls} unresolved calls` : bd && level < 6 ? `${n.label}\n${bd}` : detail;
        return { data: { id: n.id, label: labelText, erRows, umlLines: uml ? 2 + umlNotes.length + ((n.node?.notes?.length ?? 0) > umlNotes.length ? 1 : 0) : 1, lensColor: chartColor(n.node?.file ?? n.label, n.role), lensFill: chartFill(chartColor(n.node?.file ?? n.label, n.role)), hasBadge: bd ? 1 : 0, heatv: n.node?.heat ? n.node.heat.value : -1, ghost: n.node?.ghost ? 1 : 0, inTx: n.inTx ? 1 : 0, detail: level >= 6 ? 1 : 0, testOverlaySize: 0, runtimeOverlaySize: 0, tier: n.tier, display: n.displayMode, role: n.role ?? "", kind: n.kind, parent: n.parent }, position: { ...n.pos }, classes: n.stale ? "stale" : "" };
      }),
      ...rendered.edges.map((e) => {
        const at = (id: string) => nodePos.get(id);
        const a = at(e.from), b = at(e.to);
        const seg = e.from !== e.to && e.via && a && b ? viaToSegments(a, b, automatic ? e.via.slice(1, -1) : e.via) : null;
        return { ...({ data: { id: e.id, source: e.from, target: e.to, display: e.displayMode, kind: e.kind ?? "", sourceLabel: e.sourceLabel ?? "", targetLabel: e.targetLabel ?? "", label: level >= 5 || e.count > 1 ? e.label : "", count: e.count, ghost: e.ghost ? 1 : 0, ret: e.ret ? 1 : 0, ambient: e.ambient ? 1 : 0 }, classes: e.stale ? "stale" : "" }), ...(seg ? { style: { "curve-style": "segments", "segment-weights": seg.weights, "segment-distances": seg.distances, "edge-distances": "node-position" } } : {}) };
      }),
    ];
    c.add(els);
    // Apply routed edge geometry as a bypass after insertion. Cytoscape's element
    // insertion does not reliably install the style object from an element definition.
    for (const element of els) if (element.style) c.getElementById(element.data.id!).style(element.style);
    if (p.viewKey !== lastViewKey.current || (automatic && aspect !== lastLayoutAspect.current)) {
      const first = lastViewKey.current === "";
      lastViewKey.current = p.viewKey;
      if (first && p.initialState) { c.zoom(p.initialState.zoom); c.pan(p.initialState.pan); } else fitReadable(c, p.formId === "GeneratedChart" || !p.semanticLevels);
    }
    // Reapply selection to the fresh elements.
    c.batch(() => { for (const id of p.selected) c.getElementById(id).select(); });
    focusEdges(c, focusId.current);
    syncing.current = false;
    refreshRef.current();
    lens.current?.refresh();
    lastLayoutAspect.current = aspect;
  }, [p.rendered, p.viewKey, layoutReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Replay decorates existing elements without moving the camera or changing provenance styles.
  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.batch(() => {
      c.nodes().removeClass("replay-observed replay-error");
      for (const n of p.rendered.nodes) {
        const hits = n.members.filter((id) => p.replayNodes?.has(id));
        if (hits.length) c.getElementById(n.id).addClass(hits.some((id) => p.replayNodes?.get(id)) ? "replay-observed replay-error" : "replay-observed");
      }
    });
  }, [p.replayNodes, p.rendered]);

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    c.batch(() => {
      for (const n of p.rendered.nodes) {
        const el = c.getElementById(n.id);
        el.removeClass("test-overlay-failing test-overlay-covered test-overlay-low test-overlay-linked test-overlay-unknown runtime-overlay-errors runtime-overlay-observed runtime-overlay-unknown");
        const mark = p.overlayNodes?.get(n.id);
        el.data({ testOverlaySize: mark?.testSize ?? 0, runtimeOverlaySize: mark?.runtimeSize ?? 0 });
        if (mark) el.addClass(`test-overlay-${mark.test} runtime-overlay-${mark.runtime}`);
      }
    });
  }, [p.overlayNodes, p.rendered]);

  useEffect(() => {
    const refreshStyle = () => { cy.current?.style(style()); };
    const observer = new MutationObserver(refreshStyle);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-contrast"] });
    const theme = matchMedia("(prefers-color-scheme: dark)");
    theme.addEventListener("change", refreshStyle);
    return () => { observer.disconnect(); theme.removeEventListener("change", refreshStyle); };
  }, []);

  useEffect(() => { cy.current?.userPanningEnabled(!p.boxSelect); }, [p.boxSelect]);

  // An explicit level choice is a request to see that level: land readable on the anchor, disclose the rest.
  const lastFit = useRef(p.fitTick);
  useEffect(() => {
    const c = cy.current;
    if (!c || !layoutReady || p.fitTick === lastFit.current) return;
    lastFit.current = p.fitTick;
    const policy = p.policy ?? (p.formId ? detailPolicyFor(p.formId as Parameters<typeof detailPolicyFor>[0]) : undefined);
    if (policy?.aggregationSupported && p.semanticLevels) {
      const candidate = renderedLevelFromGraph(p.rendered, p.level, policy);
      const anchor = captureAnchor(c, p.rendered, p.selected, pointer.current, focusId.current);
      const semAnchor: SemanticAnchor = {
        entityIds: anchor.ids,
        screenPoint: anchor.screen ?? { x: c.width() / 2, y: c.height() / 2 },
        selectionId: [...p.selected][0],
        source: anchor.screen ? "POINTER" : p.selected.size ? "SELECTION" : "CENTRE",
      };
      const plan = planTransition({
        currentCamera: { zoom: c.zoom(), pan: c.pan() },
        viewport: { width: c.width(), height: c.height() },
        anchor: semAnchor,
        candidate,
        policy,
        kind: "EXPLICIT_LEVEL",
      });
      c.viewport(plan.camera);
    } else {
      fitReadable(c, p.formId === "GeneratedChart" || !p.semanticLevels);
    }
    refreshRef.current();
  }, [p.fitTick, p.rendered, layoutReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    syncing.current = true;
    c.batch(() => { c.nodes().unselect(); for (const id of p.selected) c.getElementById(id).select(); });
    focusEdges(c, focusId.current);
    syncing.current = false;
  }, [p.selected]);

  const setFocus = (id: string | null, say = true, expand = true) => {
    const c = cy.current; if (!c) return;
    c.nodes().removeClass("kbfocus");
    focusId.current = id;
    if (!id) return;
    const el = c.getElementById(id);
    if (el.empty()) { focusId.current = null; return; }
    el.addClass("kbfocus");
    if (expand) lens.current?.focus(el.renderedPosition());
    focusEdges(c, id);
    // A keyboard move is the user asking to look there: pan only if the node is off screen, never change zoom.
    const bb = el.renderedBoundingBox(), w = c.width(), h = c.height();
    if (bb.x1 < 0 || bb.y1 < 0 || bb.x2 > w || bb.y2 > h) c.center(el);
    const n = cb.current.rendered.nodes.find((x) => x.id === id);
    if (n && say) cb.current.announce(describeNode(n, cb.current.rendered, cb.current.selected.has(id)));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!layoutReady) return;
    const c = cy.current; if (!c || e.altKey || e.ctrlKey || e.metaKey) return;
    const nodes = cb.current.rendered.nodes;
    const dirs: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    const cur = nodes.find((n) => n.id === focusId.current) ?? null;
    if (dirs[e.key]) {
      e.preventDefault();
      const items = nodes.map((n) => { const q = c.getElementById(n.id).position(); return { id: n.id, x: q.x, y: q.y }; });
      const next = nextByDirection(items, focusId.current, dirs[e.key]);
      if (next) setFocus(next); else if (focusId.current) cb.current.announce("No element further in that direction");
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const sorted = nodes.map((n) => { const q = c.getElementById(n.id).position(); return { id: n.id, x: q.x, y: q.y }; }).sort((a, b) => a.x - b.x || a.y - b.y);
      if (sorted.length) setFocus(e.key === "Home" ? sorted[0].id : sorted[sorted.length - 1].id);
    } else if (e.key === "Enter" && cur) { e.preventDefault(); cb.current.onTapNode(cur); }
    else if (e.key === " " && cur) { e.preventDefault(); cb.current.onToggleNode(cur); }
    else if ((e.key === "e" || e.key === "E") && cur) { e.preventDefault(); lens.current?.focus(c.getElementById(cur.id).renderedPosition()); }
    else if (e.key === "Escape") { cb.current.onClear(); cb.current.announce("Selection cleared"); }
    else if (e.key === "o" || e.key === "O") { e.preventDefault(); cb.current.onOpenOutline(); }
  };

  // Keep the focus ring on the same element across re-renders (verdicts, level changes); drop it if the element is gone.
  useEffect(() => { if (focusId.current) setFocus(focusId.current, false, false); }, [p.rendered]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
    <div className="canvas" ref={host} tabIndex={0} role="application" aria-busy={!layoutReady} data-layout-engine={automatic ? layoutReady ? layout!.engine : "pending" : "notation"} aria-label={`Map. ${p.caption || "Empty."}`} aria-describedby="canvas-help" onKeyDown={onKeyDown}
      onMouseDown={() => host.current?.focus()}
      onFocus={() => { if (layoutReady && !focusId.current && cb.current.rendered.nodes.length) { const c = cy.current!; const first = [...cb.current.rendered.nodes].sort((a, b) => { const qa = c.getElementById(a.id).position(), qb = c.getElementById(b.id).position(); return qa.x - qb.x || qa.y - qb.y; })[0]; setFocus(first.id, false, false); } }} />
    {!layoutReady && <div className="canvas-hint" role="status">Arranging graph…</div>}
    <div className="lens-controls" role="group" aria-label="Hover expansion">
      <button type="button" aria-pressed={!lensState.enabled} onClick={() => lens.current?.configure({ enabled: !lensState.enabled })}>{lensState.enabled ? "Pause hover expansion" : "Resume hover expansion"}</button>
      <span>Hover: expand · E: focused element · Esc: dismiss · L: pause · [ / ]: pages</span>
    </div>
    {layoutReady && (hint.off > 0 || hint.labelsHidden || (automatic && layout?.engine === "fallback")) && (
      <div className="canvas-hint" role="status">
        {automatic && layout?.engine === "fallback" && <span>Automatic arrangement unavailable; showing the source layout.</span>}
        {hint.off > 0 && <span>{hint.off} of {hint.total} element{hint.total === 1 ? "" : "s"} off-screen <button type="button" className="tool" onClick={bringIntoView}>Bring into view</button></span>}
        {hint.labelsHidden && <span>Hover with the lens to read details, or open the text outline (O).</span>}
      </div>
    )}
    {tip && <div className="canvas-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </>
  );
}
