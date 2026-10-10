import { restoreWorkspace, type ResponseWorkspace } from "./response-workspace.ts";
export const NAVIGATION_LIMIT = 30;
export interface NavigationHistory { ancestors: ResponseWorkspace[]; truncated: boolean }
export interface NavigationCrumb { index: number; label: string; perspective: string; scope: "subject" | "repository"; revision: string; current: boolean }
export const emptyNavigation = (): NavigationHistory => ({ ancestors: [], truncated: false });
/** Only explicit exploration within one revision extends a branch. New questions establish new roots. */
export function extendNavigation(history: NavigationHistory, parent: ResponseWorkspace | null, next: ResponseWorkspace, exploration: boolean): NavigationHistory {
 if (!exploration || !parent || parent.manifest.revision!==next.manifest.revision) return emptyNavigation();
 const frames=[...history.ancestors,parent];
 return {ancestors:frames.slice(-NAVIGATION_LIMIT),truncated:history.truncated || frames.length>NAVIGATION_LIMIT};
}
export function jumpNavigation(history: NavigationHistory,index:number): { history: NavigationHistory; workspace: ResponseWorkspace } | undefined {
 if (!Number.isInteger(index) || index<0 || index>=history.ancestors.length) return;
 return {history:{...history,ancestors:history.ancestors.slice(0,index)},workspace:restoreWorkspace(history.ancestors[index])};
}
export function navigationCrumbs(history: NavigationHistory,current:ResponseWorkspace | null): NavigationCrumb[] {
 const frames=current ? [...history.ancestors,current] : [];
 return frames.map((w,index)=>{
  const tab=w.tabs.find(t=>t.id===w.activeId),scope=tab?.scope??w.manifest.plan?.scope??"repository";
  const concern=tab?.concern??"",code=tab?.code??"";
  const perspective=["S1","S22","S27"].includes(code) ? "Architecture" : ["S16","S17","S23"].includes(code) ? "Components" : code==="S21" ? "Code calls" : concern || "View";
  return { index, label:w.navigationLabel??(scope==="repository" ? "Repository" : tab?.subject??w.manifest.plan?.subject??w.manifest.question), perspective, scope, revision:w.manifest.revision, current:index===frames.length-1 };
 });
}
