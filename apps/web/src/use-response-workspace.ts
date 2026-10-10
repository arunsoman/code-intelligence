import { useEffect, useRef, useState } from "react";
import type { Claim, ResponseManifest, ViewSpec } from "@cie/schema";
import { call } from "./api.ts";
import { restoreWorkspace, acceptCompletion, activateTab, closeTab, createWorkspace, projectSelection, updateTab, workspaceExport,
  type ResponseWorkspace, type TabState, type WorkspaceTab } from "./response-workspace.ts";

/** Only the active renderer is mounted. Semantic specs and local UI state survive tab switches. */
export function useResponseWorkspace(p: {
  snapshot: () => TabState; currentView: ViewSpec | null;
  show: (view: ViewSpec, claims: Claim[], ui?: TabState) => void;
}) {
  const [workspace, setWorkspace] = useState<ResponseWorkspace | null>(null);
  const current = useRef<ResponseWorkspace | null>(null);
  const history = useRef<ResponseWorkspace[]>([]);
  const [historySize, setHistorySize] = useState(0);
  const requests = useRef(new Map<string, AbortController>());
  const latest = useRef(p); latest.current = p;
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current++; for (const c of requests.current.values()) c.abort(); }, []);
  const set = (next: ResponseWorkspace | null) => { current.current = next; setWorkspace(next); };
  const stash = () => {
    const w = current.current;
    if (!w) return;
    const active = w.tabs.find((t) => t.id === w.activeId);
    if (!active?.view || active.view.id !== latest.current.currentView?.id) return;
    set(updateTab(w, w.activeId, { ui: latest.current.snapshot(), ...(latest.current.currentView ? { view: latest.current.currentView } : {}) }));
  };
  const remember = () => {
    stash(); if (!current.current) return;
    history.current = [...history.current, current.current].slice(-30); setHistorySize(history.current.length);
  };
  const cancel = () => {
    epoch.current++;
    for (const controller of requests.current.values()) controller.abort();
    requests.current.clear();
    const w = current.current;
    if (w) set({ ...w, tabs: w.tabs.map((t) => t.status === "generating" ? { ...t, status: "available", reason: "Generation cancelled. Select this view to retry.", attempt: t.attempt + 1 } : t) });
  };
  const reset = () => { cancel(); set(null); history.current = []; setHistorySize(0); };
  const begin = (manifest: ResponseManifest, built: { view: ViewSpec; claims: Claim[] }[]) => {
    remember(); cancel(); const next = createWorkspace(manifest, built); set(next);
    const active = next.tabs.find((t) => t.id === next.activeId);
    if (active?.view) latest.current.show(active.view, active.claims, active.ui);
  };
  const generate = async (id: string, activate = true) => {
    let w = current.current;
    let tab = w?.tabs.find((t) => t.id === id);
    if (!w || !tab || tab.status === "unavailable" || tab.status === "stale") return;
    if (activate && w.activeId !== id) { remember(); w = current.current!; set(activateTab(w, id)); }
    w = current.current!; tab = w.tabs.find((t) => t.id === id)!;
    if (tab.view) {
      if (activate) {
        const ui = tab.ui ?? { ...latest.current.snapshot(), selection: projectSelection(latest.current.currentView ?? undefined, latest.current.snapshot().selection, tab.view), cellSelection: [], level: tab.view.level, drawMode: "matrix", terrainWeights: {}, canvas: undefined };
        latest.current.show(tab.view, tab.claims, ui);
      }
      return;
    }
    if (requests.current.has(id)) return;
    if (requests.current.size >= 2) { set(updateTab(w, id, { status: "available", reason: "Two views are already generating. Select this tab again when one finishes." })); return; }
    const attempt = tab.attempt + 1;
    const token = { responseId: w.manifest.responseId, revision: w.manifest.revision, tabId: id, attempt };
    const taskEpoch = epoch.current;
    const controller = new AbortController(); requests.current.set(id, controller);
    set(updateTab(w, id, { status: "generating", reason: undefined, attempt }));
    const result = await call<{ view: ViewSpec; claims: Claim[] }>("C19", "ask", {
      question: tab.questionAnswered, revision: token.revision, form: tab.form,
      subject: tab.subject, scope: tab.scope, seeds: tab.seeds,
      ...(tab.code.startsWith("S") ? { chartCode: tab.code } : {}),
    }, undefined, "v1", controller.signal);
    if (requests.current.get(id) === controller) requests.current.delete(id);
    if (controller.signal.aborted || epoch.current !== taskEpoch || current.current?.manifest.responseId !== token.responseId) return;
    if (!result.ok) { set(updateTab(current.current!, id, { status: "failed", reason: result.error.message })); return; }
    const next = acceptCompletion(current.current!, token, result.value); set(next);
    const completed = next.tabs.find((t) => t.id === id);
    if (next.activeId === id && completed?.view) latest.current.show(completed.view, completed.claims, completed.ui);
  };
  const back = () => {
    const frame = history.current.pop(); if (!frame) return;
    cancel(); setHistorySize(history.current.length);
    const restored = restoreWorkspace(frame);
    set(restored);
    const tab = restored.tabs.find((t) => t.id === restored.activeId);
    if (tab?.view) latest.current.show(tab.view, tab.claims, tab.ui);
    else if (tab) void generate(tab.id);
  };
  const generateAll = async () => {
    const w = current.current; if (!w) return;
    const queueEpoch = epoch.current;
    for (const tab of w.tabs.filter((t) => t.relevant && t.status !== "unavailable" && !t.view)) {
      if (epoch.current !== queueEpoch || current.current?.manifest.responseId !== w.manifest.responseId) break;
      set(updateTab(current.current!, tab.id, { open: true }));
      await generate(tab.id, false);
    }
  };
  const close = (id: string) => {
    stash(); const w = current.current; if (!w) return;
    const next = closeTab(w, id); set(next);
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
  return { workspace, active, begin, reset, cancel, back, generate, generateAll, close, exportResponse, relate,
    pending: workspace?.tabs.some((t) => t.status === "generating") ?? false, canBack: historySize > 0,
    waiting: !!active && !active.view, current: () => current.current, snapshot: () => { stash(); return current.current; } };
}
