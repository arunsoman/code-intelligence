import { encodeCheckpoint, decodeCheckpoint } from "./workspace-checkpoint.ts";
import { GenerationQueue } from "./generation-queue.ts";
import { emptyNavigation, extendNavigation, jumpNavigation, navigationCrumbs, type NavigationHistory } from "./exploration-navigation.ts";
import { useEffect, useRef, useState } from "react";
import type { ApiResult, Claim, ResponseManifest, ViewSpec } from "@cie/schema";
import { call } from "./api.ts";
import { acceptCompletion, activateTab, closeTab, createWorkspace, perspectiveState, updateTab, workspaceExport,
  type ResponseWorkspace, type TabState, type WorkspaceTab } from "./response-workspace.ts";

/** Only the active renderer is mounted. Semantic specs and local UI state survive tab switches. */
export function useResponseWorkspace(p: {
  sessionId: string; revision?: string;
  snapshot: () => TabState; currentView: ViewSpec | null;
  show: (view: ViewSpec, claims: Claim[], ui?: TabState) => void;
}) {
  const [workspace, setWorkspace] = useState<ResponseWorkspace | null>(null);
  const current = useRef<ResponseWorkspace | null>(null);
  const history = useRef<NavigationHistory>(emptyNavigation());
  const [navigation, setNavigation] = useState<NavigationHistory>(emptyNavigation());
  const setHistory = (next: NavigationHistory) => { history.current=next; setNavigation(next); };
  const [requests] = useState(() => new GenerationQueue<ApiResult<{view:ViewSpec;claims:Claim[]}>>());
  const latest = useRef(p); latest.current = p;
  const epoch = useRef(0);
  const checkpointOwner=useRef({sessionId:p.sessionId,revision:p.revision});
  const storageKey=p.revision?`cie-response:${p.sessionId}:${p.revision}`:undefined;
  const restoredKey=useRef<string|undefined>(undefined);
  const persist=() => {
    const w=current.current;if(!storageKey||!w||w.manifest.revision!==latest.current.revision||checkpointOwner.current.sessionId!==latest.current.sessionId||checkpointOwner.current.revision!==latest.current.revision)return;
    const active=w.tabs.find(t=>t.id===w.activeId);
    const snapshot=active?.view?.id===latest.current.currentView?.id?updateTab(w,w.activeId,{ui:latest.current.snapshot()}):w;
    try {const text=encodeCheckpoint(snapshot,history.current);if(text)sessionStorage.setItem(storageKey,text);else sessionStorage.removeItem(storageKey);}catch{/* In-memory navigation remains usable when storage is unavailable. */}
  };
  useEffect(()=>{persist();},[workspace,navigation,storageKey]);
  useEffect(()=>{const save=()=>persist();window.addEventListener("pagehide",save);window.addEventListener("beforeunload",save);return()=>{window.removeEventListener("pagehide",save);window.removeEventListener("beforeunload",save);};},[storageKey]);
  useEffect(()=>{
    if(!storageKey||restoredKey.current===storageKey)return;
    restoredKey.current=storageKey;
    if(current.current?.manifest.revision===p.revision&&checkpointOwner.current.sessionId===p.sessionId&&checkpointOwner.current.revision===p.revision)return;
    cancel();set(null);setHistory(emptyNavigation());checkpointOwner.current={sessionId:p.sessionId,revision:p.revision};
    let saved:ReturnType<typeof decodeCheckpoint>;
    try {const text=sessionStorage.getItem(storageKey);if(text)saved=decodeCheckpoint(text,p.revision!);if(text&&!saved)sessionStorage.removeItem(storageKey);}catch{return;}
    if(saved){cancel();setHistory(saved.navigation);set(saved.workspace);void generate(saved.workspace.activeId);}
  },[storageKey]);
  useEffect(() => () => { epoch.current++; requests.cancelAll(); }, []);
  const set = (next: ResponseWorkspace | null) => { current.current = next; setWorkspace(next); };
  const stash = () => {
    const w = current.current;
    if (!w) return;
    const active = w.tabs.find((t) => t.id === w.activeId);
    if (!active?.view || (active.view.id !== latest.current.currentView?.id || active.view.revision !== latest.current.currentView?.revision)) return;
    set(updateTab(w, w.activeId, { ui: latest.current.snapshot(), ...(latest.current.currentView ? { view: latest.current.currentView } : {}) }));
  };
  const cancel = () => {
    epoch.current++;
    requests.cancelAll();
    const w = current.current;
    if (w) set({ ...w, tabs: w.tabs.map((t) => (t.status === "generating" || t.status === "queued") ? { ...t, status: "available", reason: "Generation cancelled. Select this view to retry.", attempt: t.attempt + 1 } : t) });
  };
  const reset = () => { try {if(storageKey)sessionStorage.removeItem(storageKey);}catch{} cancel(); set(null); setHistory(emptyNavigation()); };
  const begin = (manifest: ResponseManifest, built: { view: ViewSpec; claims: Claim[] }[], explorationLabel?: string) => {
    checkpointOwner.current={sessionId:latest.current.sessionId,revision:latest.current.revision};
    stash(); const parent=current.current;
    let next={...createWorkspace(manifest,built),...(explorationLabel ? {navigationLabel:explorationLabel} : {})};
    const initial=next.tabs.find(t=>t.id===next.activeId);
    if (explorationLabel!==undefined && initial?.view) next=updateTab(next,next.activeId,{ui:perspectiveState(latest.current.currentView??undefined,initial.view,latest.current.snapshot())});
    setHistory(extendNavigation(history.current,parent,next,explorationLabel!==undefined));
    cancel(); set(next);
    const active = next.tabs.find((t) => t.id === next.activeId);
    if (active?.view) latest.current.show(active.view, active.claims, active.ui);
  };
  const generate = async (id: string, activate = true) => {
    let w = current.current;
    let tab = w?.tabs.find((t) => t.id === id);
    if (!w || !tab || tab.status === "unavailable" || tab.status === "stale") return;
    if (activate && w.activeId !== id) { stash(); w = current.current!; set(activateTab(w, id)); }
    w = current.current!; tab = w.tabs.find((t) => t.id === id)!;
    if (tab.view) {
      if (activate) {
        const ui = tab.ui ?? perspectiveState(latest.current.currentView ?? undefined,tab.view,latest.current.snapshot());
        latest.current.show(tab.view, tab.claims, ui);
      }
      return;
    }
    if (requests.has(id)) { if(activate)requests.promote(id); return; }
    const attempt = tab.attempt + 1;
    const token = { responseId: w.manifest.responseId, revision: w.manifest.revision, tabId: id, attempt };
    const taskEpoch = epoch.current;
    set(updateTab(w, id, { status: "queued", reason: "Waiting for a generation slot. This view will start automatically.", attempt }));
    const outcome = await requests.enqueue(id, signal => call<{ view: ViewSpec; claims: Claim[]; manifest?: ResponseManifest }>("C19", "ask", {
      question: tab!.questionAnswered, revision: token.revision, form: tab!.form,
      subject: tab!.subject, scope: tab!.scope, seeds: tab!.seeds,
      ...(tab!.code.startsWith("S") ? { chartCode: tab!.code } : {}),
    }, undefined, "v1", signal), activate ? "foreground" : "supporting", () => {
      const active=current.current;
      if(epoch.current===taskEpoch && active?.manifest.responseId===token.responseId && active.tabs.find(t=>t.id===id)?.attempt===attempt)
        set(updateTab(active,id,{status:"generating",reason:undefined}));
    });
    if (outcome.status === "cancelled" || epoch.current !== taskEpoch || current.current?.manifest.responseId !== token.responseId || current.current.tabs.find(t=>t.id===id)?.attempt!==attempt) return;
    if(outcome.status === "failed") { set(updateTab(current.current!,id,{status:"failed",reason:outcome.message})); return; }
    const result=outcome.value;
    if (!result.ok) { set(updateTab(current.current!, id, { status: "failed", reason: result.error.message })); return; }
    let next = acceptCompletion(current.current!, token, result.value);
    const fresh = (result.value as { manifest?: ResponseManifest }).manifest;
    if (fresh?.revision === token.revision && next.tabs.find(t => t.id === id)?.view?.id === result.value.view.id)
      next = { ...next, manifest: { ...next.manifest, sections: fresh.sections, limitations: fresh.limitations, interpretation: fresh.interpretation } };
    set(next);
    const completed = next.tabs.find((t) => t.id === id);
    if (next.activeId === id && completed?.view) latest.current.show(completed.view, completed.claims, completed.ui);
  };
  const jump = (index:number) => {
    const result=jumpNavigation(history.current,index); if (!result) return;
    cancel(); setHistory(result.history); set(result.workspace);
    const tab=result.workspace.tabs.find(t=>t.id===result.workspace.activeId);
    if (tab?.view) latest.current.show(tab.view,tab.claims,tab.ui);
    else if (tab) void generate(tab.id);
  };
  const back = () => jump(history.current.ancestors.length-1);
  const generateAll = async () => {
    const w = current.current; if (!w) return;
    const tabs=w.tabs.filter(t=>t.relevant && !t.primary && t.status!=="unavailable" && t.status!=="stale" && !t.view).slice(0,3);
    for(const tab of tabs)set(updateTab(current.current!,tab.id,{open:true}));
    await Promise.all(tabs.map(tab=>generate(tab.id,false)));
  };
  const close = (id: string) => {
    stash(); const w = current.current; if (!w) return;
    if(w.tabs.filter(t=>t.open).length<=1)return;
    requests.cancel(id);
    const tab=w.tabs.find(t=>t.id===id);
    const retryable=tab && (tab.status==="generating" || tab.status==="queued") ? updateTab(w,id,{status:"available",reason:"Generation stopped when this tab closed. Reopen to retry.",attempt:tab.attempt+1}) : w;
    const next = closeTab(retryable, id); set(next);
    if (next.activeId !== w.activeId) void generate(next.activeId);
  };
  const exportResponse = () => {
    stash(); if (!current.current) return;
    const url = URL.createObjectURL(new Blob([workspaceExport(current.current)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "code-intelligence-response.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const active = workspace?.tabs.find((t) => t.id === workspace.activeId);
  const relate = (tab: WorkspaceTab) => {
    if (!tab.view) return;
    latest.current.show(tab.view, tab.claims, { ...latest.current.snapshot(), selection: tab.view.nodes.filter((n) => n.evidenceIds.length).map((n) => n.id) });
  };
  return { workspace, active, begin, reset, cancel, back, jump, generate, generateAll, close, exportResponse, relate,
    pending: workspace?.tabs.some((t) => t.status === "generating" || t.status === "queued") ?? false, canBack: navigation.ancestors.length > 0, breadcrumbs: navigationCrumbs(navigation,workspace), navigationTruncated: navigation.truncated,
    waiting: !!active && !active.view, current: () => current.current, snapshot: () => { stash(); return current.current; } };
}
