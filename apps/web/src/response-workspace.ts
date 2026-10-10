import type { Claim, ResponseManifest, ResponseView, ViewSpec } from "@cie/schema";
import type { LensState } from "./fisheye.ts";

export interface CanvasState { zoom: number; pan: { x: number; y: number }; lens: LensState }
export interface TabState {
  selection: string[]; cellSelection: string[]; level: number; drawMode: "matrix" | "graph";
  terrainWeights: Record<string, number>; canvas?: CanvasState;
}
export interface WorkspaceTab extends ResponseView {
  open: boolean; view?: ViewSpec; claims: Claim[]; ui?: TabState; attempt: number;
}
export interface ResponseWorkspace {
  manifest: ResponseManifest; tabs: WorkspaceTab[]; activeId: string; navigationLabel?: string;
}

export function createWorkspace(manifest: ResponseManifest, built: { view: ViewSpec; claims: Claim[] }[]): ResponseWorkspace {
  const initial = new Set(manifest.views.filter((d) => d.relevant && d.status !== "unavailable").slice(0, 4).map((d) => d.id));
  return { manifest, activeId: manifest.primaryViewId, tabs: manifest.views.map((d) => {
    const match = built.find((b) => b.view.id === d.viewId);
    return { ...d, open: initial.has(d.id) || !!match, claims: match?.claims ?? [], view: match?.view, attempt: 0 };
  }) };
}
export function updateTab(workspace: ResponseWorkspace, id: string, update: Partial<WorkspaceTab>): ResponseWorkspace {
  return { ...workspace, tabs: workspace.tabs.map((t) => t.id === id ? { ...t, ...update } : t) };
}
export function activateTab(workspace: ResponseWorkspace, id: string): ResponseWorkspace {
  if (!workspace.tabs.some((t) => t.id === id && t.status !== "unavailable")) return workspace;
  return { ...updateTab(workspace, id, { open: true }), activeId: id };
}
export function closeTab(workspace: ResponseWorkspace, id: string): ResponseWorkspace {
  if (workspace.tabs.filter((t) => t.open).length <= 1) return workspace;
  const next = updateTab(workspace, id, { open: false });
  return { ...next, activeId: workspace.activeId === id ? next.tabs.find((t) => t.open)!.id : workspace.activeId };
}
/** A completion is useful only for its exact response, revision and request attempt. */
export function acceptCompletion(workspace: ResponseWorkspace, token: { responseId: string; revision: string; tabId: string; attempt: number }, built: { view: ViewSpec; claims: Claim[] }): ResponseWorkspace {
  const tab = workspace.tabs.find((t) => t.id === token.tabId);
  if (workspace.manifest.responseId !== token.responseId || workspace.manifest.revision !== token.revision || built.view.revision !== token.revision || tab?.attempt !== token.attempt) return workspace;
  if (tab.code.startsWith("S") && built.view.params?.chartId !== tab.code) return updateTab(workspace, tab.id, { status: "failed", reason: "The requested notation was not returned. Choose another view explicitly." });
  if (!tab.code.startsWith("S") && built.view.formId !== tab.form) return updateTab(workspace, tab.id, { status: "failed", reason: "The requested view was unavailable; its fallback was not substituted." });
  return updateTab(workspace, tab.id, { view: built.view, claims: built.claims, status: built.view.gaps.length ? "partial" : "ready", reason: built.view.gaps[0] });
}

export function projectSelection(from: ViewSpec | undefined, selection: string[], to: ViewSpec): string[] {
  const entities = new Set(from?.nodes.filter((n) => selection.includes(n.id)).flatMap((n) => n.entityRefs));
  return to.nodes.filter((n) => n.entityRefs.some((id) => entities.has(id))).map((n) => n.id);
}

/** A different diagram keeps semantic selection, but begins with its own geometry and defaults. */
export function perspectiveState(from: ViewSpec | undefined, to: ViewSpec, previous: TabState): TabState {
 return { ...previous, selection: projectSelection(from,previous.selection,to), cellSelection: [], level: to.level, drawMode: "matrix", terrainWeights: {}, canvas: undefined };
}

export function workspaceExport(workspace: ResponseWorkspace): string {
  return JSON.stringify({ schemaVersion: "workspace.v1", manifest: workspace.manifest, activeId: workspace.activeId, navigationLabel: workspace.navigationLabel,
    views: workspace.tabs.filter((t) => t.open).map((t) => ({ ...t, ui: undefined })) }, null, 2);
}

/** Cancelled history requests must become retryable; all saved UI coordinates survive. */
export function restoreWorkspace(frame: ResponseWorkspace): ResponseWorkspace {
  return { ...frame, tabs: frame.tabs.map(t => t.status === "generating" ? { ...t, status: "available" as const, reason: "Select this view to retry generation.", attempt: t.attempt + 1 } : t) };
}
