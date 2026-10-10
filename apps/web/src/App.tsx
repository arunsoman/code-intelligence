import { explorationChoices } from "./exploration-choices.ts";
import { rendererForView } from "./plugins/renderers/index.ts";
import { ResponseWorkspaceBar } from "./ResponseWorkspaceBar.tsx";
import { useResponseWorkspace } from "./use-response-workspace.ts";
import type { CanvasState } from "./response-workspace.ts";
import type { EntityCode, ResponseManifest } from "@cie/schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiResult, AuditEvent, JobView, ChangesSince, Claim, ConverseResult, EditorContext, ExplainResult, MapOverlays, MatrixAxis, MatrixCell, ResolvedEvidence, RevisionInfo, SavedState, StatusInfo, VerdictKind, ViewNode, ViewSpec, WorkspaceOpen } from "@cie/schema";
import { call } from "./api.ts";
import { selectedChartId } from "./chart-selection.ts";
import type { ChatAnalysisResult } from "@cie/schema";
import { RepositoryGit } from "./RepositoryGit.tsx";
import type { RepositoryGitInfo } from "@cie/schema";
import { buttonFeedback } from "./button.ts";
import { Canvas } from "./Canvas.tsx";
import { ChatPanel, type Message, type MessageAlt } from "./ChatPanel.tsx";
import { ModelMenu } from "./ModelMenu.tsx";
import { CanvasSkeleton, Loading } from "./Skeleton.tsx";
import { COMPOSING_CAPTION, EMPTY_NO_INDEX, canvasPhase, emptyStageCopy } from "./loading.ts";
import { ClaimCard } from "./ClaimCard.tsx";
import { ConceptHierarchyBrowser } from "./ConceptHierarchyBrowser.tsx";
import { MODE_INFO, hierarchySummary } from "./concept-hierarchy-view.ts";
import type { ConceptHierarchyView } from "@cie/schema";
import { Outline } from "./Outline.tsx";
import { Consequences } from "./Consequences.tsx";
import { TerrainView } from "./TerrainView.tsx";
import { MatrixView } from "./MatrixView.tsx";
import { JobBar } from "./JobBar.tsx";
import { VisualsGallery, type CatalogEntry } from "./VisualsGallery.tsx";
import { ProviderWizard } from "./ProviderWizard.tsx";
import { FolderPicker } from "./FolderPicker.tsx";
import { DefectPanel } from "./DefectPanel.tsx";
import { PrPanel } from "./PrPanel.tsx";
import { ProfilePanel } from "./ProfilePanel.tsx";
import { TaskPanel } from "./TaskPanel.tsx";
import { BuildFeature } from "./build/BuildFeature.tsx";
import { CampaignPanel } from "./CampaignPanel.tsx";
import { ReleaseWizardPanel } from "./ReleaseWizardPanel.tsx";
import { ReleaseBoardPanel } from "./ReleaseBoardPanel.tsx";
import { ReleaseLensPanel } from "./ReleaseLensPanel.tsx";
import { SearchPanel } from "./SearchPanel.tsx";
import { HotspotPanel } from "./HotspotPanel.tsx";
import { InsightsPanel } from "./InsightsPanel.tsx";
import { InvestigationPanel } from "./InvestigationPanel.tsx";
import { Modal } from "./Modal.tsx";
import { overlayMarks } from "./mapoverlays.ts";
import { RuntimeReplay, type ReplayFrame } from "./RuntimeReplay.tsx";
import { EpistemicSummary } from "./EpistemicSummary.tsx";
import { arrange } from "./arrange.ts";
import { semanticLevelsApply } from "./detail.ts";
import { DEFAULT_LEVEL, LEVELS, MAX_LEVEL, basePositions, cellKey, effectiveView, selectedAggregates, type RenderEdge, type RenderNode } from "./graph.ts";

interface ExceptionRow { id: string; errorClass: string; message: string; trace: string; source: string; count: number; lastSeen: string }
type Drawer =
  | { kind: "explain"; data: ExplainResult }
  | { kind: "inspect"; title: string; sub: string; notes: string[]; factors?: ViewNode["factors"]; claimIds: string[]; evidence: ResolvedEvidence[]; members?: string[]; entityId?: string }
  | null;

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const CLASS_LABEL: Record<string, string> = { STATIC_PARSED: "Parsed from source", STATIC_RESOLVED: "Statically resolved", INFERRED: "Model inference", RUNTIME: "Pasted trace (unverified)", HISTORY: "Git history", TEST: "Test" };
const EXAMPLES = ["Show me how authentication works", "Show me everything that could cause a payment to fail", "Why could this balance become incorrect?"];

export function App() {
  const [highContrast, setHighContrast] = useState(() => { try { return localStorage.getItem("cie-high-contrast") === "true"; } catch { return false; } });
  const [replay, setReplay] = useState<ReplayFrame | null>(null);
  const [showTestOverlay, setShowTestOverlay] = useState(false);
  const [showRuntimeOverlay, setShowRuntimeOverlay] = useState(false);
  const [overlayWindowName, setOverlayWindowName] = useState<"24h" | "7d" | "30d">("7d");
  const [overlayRefresh, setOverlayRefresh] = useState(0);
  const [overlays, setOverlays] = useState<MapOverlays | null>(null);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [overlayBusy, setOverlayBusy] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.contrast = highContrast ? "high" : "normal";
    try { localStorage.setItem("cie-high-contrast", String(highContrast)); } catch { /* Preferences can still work without storage. */ }
  }, [highContrast]);
  const [info, setInfo] = useState<StatusInfo | null>(null);
  const [repoPath, setRepoPath] = useState("");
  const selectedRepoRef = useRef("");
  const repoGeneration = useRef(0);
  const canvasSnapshot = useRef<CanvasState | undefined>(undefined);
  const [canvasRestore, setCanvasRestore] = useState<CanvasState | undefined>(undefined);
  const responseGeneration = useRef(0);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [view, setView] = useState<ViewSpec | null>(null);
  const [claimMap, setClaimMap] = useState<Record<string, Claim>>({});
  const [selection, setSelection] = useState<string[]>([]); // view node ids (symbol identity)
  const [level, setLevel] = useState<number>(DEFAULT_LEVEL);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [code, setCode] = useState<{ title: string; file: string; startLine: number; snippet: string } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatSessionId, setChatSessionId] = useState(() => {
    try { return localStorage.getItem("cie-chat-session") || uuid(); } catch { return uuid(); }
  });
  const chatRestoreGeneration = useRef(0);
  useEffect(() => { try { localStorage.setItem("cie-chat-session", chatSessionId); } catch { /* The active tab still keeps its session. */ } }, [chatSessionId]);
  useEffect(() => {
    let active = true;
    const generation = chatRestoreGeneration.current;
    void call<{ sessionId: string; turns: { seq: number; role: "user" | "assistant"; text: string; at: string }[] }>("C15", "conversation", { sessionId: chatSessionId }).then((r) => {
      if (!active || generation !== chatRestoreGeneration.current || !r.ok) return;
      setMessages(r.value.turns.map((turn) => ({ id: `turn-${turn.seq}`, role: turn.role, text: turn.text, at: turn.at })));
    });
    return () => { active = false; };
  }, [chatSessionId]);
  const [events, setEvents] = useState<SavedState["events"]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Gaps and left-out candidates open in a popover above the footer, so reading them cannot resize the canvas. (#52)
  const [footerOpen, setFooterOpen] = useState({ gaps: false, hidden: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; version: number; updatedAt: string }[]>([]);
  const [ws, setWs] = useState<{ id?: string; version: number }>({ version: 0 });
  const [wsName, setWsName] = useState("");
  const [stale, setStale] = useState<{ files: string[]; evidence: number } | null>(null);
  const [changes, setChanges] = useState<ChangesSince | null>(null);
  const [picking, setPicking] = useState(false);
  const [boxSelect, setBoxSelect] = useState(false);
  const [editorFocus, setEditorFocus] = useState<{ entityId: string; label: string }[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [fitTick, setFitTick] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [providerWizardOpen, setProviderWizardOpen] = useState(false);
  const [defectsOpen, setDefectsOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [buildContext, setBuildContext] = useState<{ releaseId?: string; requestId?: string } | null>(null);
  const [campaignsOpen, setCampaignsOpen] = useState(false);
  const [releasesOpen, setReleasesOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [lensOpen, setLensOpen] = useState(false);
  const [lensReleaseId, setLensReleaseId] = useState<string | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hotspotsOpen, setHotspotsOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [chatSeed, setChatSeed] = useState<{ text: string; n: number } | null>(null);
  /** "Ask about this finding" (UX-57): close the drawer, fill the composer, put the focus there. */
  const askFromInsights = (question: string) => { setInsightsOpen(false); setChatSeed({ text: question, n: Date.now() }); requestAnimationFrame(() => document.getElementById("chat-input")?.focus()); };
  const [investigationsOpen, setInvestigationsOpen] = useState(false);
  const [drawMode, setDrawMode] = useState<"matrix" | "graph">("matrix");
  const [cellSel, setCellSel] = useState<string[]>([]); // matrix cells chosen as "these" for the next message
  const [terrainWeights, setTerrainWeights] = useState<Record<string, number>>({});
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // UX-04: collapsible side pane
  const [sideCollapsed, setSideCollapsed] = useState(false);
  // UX-07: repo section expand/collapse, auto-collapses once when indexed
  const [repoExpanded, setRepoExpanded] = useState(true);
  const [repoAutoCollapsed, setRepoAutoCollapsed] = useState(false);
  // UX-12: view controls collapsible
  const [viewCtrlOpen, setViewCtrlOpen] = useState(true);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [browsingHierarchy, setBrowsingHierarchy] = useState(false);
  const [hierarchyConcepts, setHierarchyConcepts] = useState(0);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [cardPins, setCardPins] = useState<{ title: string; ids: string[] } | null>(null);
  const [audit, setAudit] = useState<{ events: AuditEvent[]; chain: { ok: boolean } } | null>(null);

  const responseWorkspace = useResponseWorkspace({
    currentView: view,
    snapshot: () => ({ selection, cellSelection: cellSel, level, drawMode, terrainWeights, canvas: canvasSnapshot.current }),
    show: (next, claims, ui) => {
      adoptView(next, claims, false);
      canvasSnapshot.current = ui?.canvas; setCanvasRestore(ui?.canvas);
      if (ui) { setSelection(ui.selection); setCellSel(ui.cellSelection); setLevel(ui.level); setDrawMode(ui.drawMode); setTerrainWeights(ui.terrainWeights); }
      setExploreOpen(false);
    },
  });
  const navigateBack = () => { responseGeneration.current++; setBusy(null); if (code) { setCode(null); return; } responseWorkspace.back(); };
  const resetResponse = () => { responseGeneration.current++; responseWorkspace.reset(); canvasSnapshot.current = undefined; setCanvasRestore(undefined); };
  const sourceContext = useRef(""); sourceContext.current = `${view?.revision}:${view?.id}:${selection.join("|")}`;
  const selectedSubjects = (view?.nodes ?? []).filter((n) => selection.includes(n.id) && n.entityRefs.length);
  const exploreTarget = selectedSubjects.length === 1 ? selectedSubjects[0] : undefined;
  const exploreChoices = exploreTarget ? explorationChoices(exploreTarget.kind, responseWorkspace.workspace?.manifest) : [];
  const explore = (choice: typeof exploreChoices[number]) => {
    if (!exploreTarget || !view || choice.disabled) return;
    void askForm(`Show the ${choice.concern} of ${exploreTarget.label}`, choice.form, exploreTarget.label, undefined, undefined, undefined, choice.code.startsWith("S") ? choice.code : undefined,
      { revision: view.revision, seeds: exploreTarget.entityRefs, scope: "subject" });
  };
  const openSource = async () => {
    if (!exploreTarget || !view || exploreTarget.entityRefs.length !== 1) return;
    const sourceView = view;
    const sourceKey = sourceContext.current;
    const token = responseGeneration.current;
    const r = await call<EntityCode>("C11", "conceptCode", { revision: sourceView.revision, entityId: exploreTarget.entityRefs[0] });
    if (token !== responseGeneration.current || sourceKey !== sourceContext.current) return;
    if (!r.ok) { setError(failMsg(r)); return; }
    if (r.value.state !== "CURRENT" && r.value.state !== "STALE") { setNotice(`Source is ${r.value.state.toLowerCase()}.`); return; }
    setCode({ title: r.value.name, file: r.value.file, startLine: r.value.startLine, snippet: r.value.text });
  };

  const closeAllDialogs = useCallback(() => {
    setGalleryOpen(false);
    setProviderWizardOpen(false);
    setDefectsOpen(false);
    setPrOpen(false);
    setProfilesOpen(false);
    setTasksOpen(false);
    setBuildOpen(false);
    setCampaignsOpen(false);
    setReleasesOpen(false);
    setBoardOpen(false);
    setLensOpen(false);
    setSearchOpen(false);
    setHotspotsOpen(false);
    setInsightsOpen(false);
    setInvestigationsOpen(false);
    setJobsOpen(false);
    setBrowsingHierarchy(false);
    setOutlineOpen(false);
    setAudit(null);
    setPicking(false);
  }, []);

  const openDialog = useCallback((opener: () => void) => {
    closeAllDialogs();
    opener();
  }, [closeAllDialogs]);

  const log = useCallback((kind: string, detail?: string) => setEvents((e) => [...e, { kind, at: now(), detail }].slice(-200)), []);
  const say = useCallback((role: Message["role"], text: string, isError = false, thinking?: string) => setMessages((m) => [...m, { role, text, at: now(), error: isError, ...(thinking ? { thinking } : {}) }].slice(-200)), []);
  const mergeClaims = useCallback((cs: Claim[]) => setClaimMap((m) => ({ ...m, ...Object.fromEntries(cs.map((c) => [c.draft.id, c])) })), []);

  const refresh = useCallback(async (repoRoot = selectedRepoRef.current) => {
    const requestedRoot = repoRoot || undefined;
    const [s, l] = await Promise.all([
      call<StatusInfo>("C01", "status", requestedRoot ? { repoRoot: requestedRoot } : {}),
      call<typeof workspaces>("C13", "listWorkspaces"),
    ]);
    if (selectedRepoRef.current !== repoRoot) return; // Ignore responses for a repository the user has since left.
    if (s.ok) {
      setInfo(s.value);
      const rev = s.value.revision;
      if (rev) {
        if (!selectedRepoRef.current) { selectedRepoRef.current = rev.repoRoot; setRepoPath((p) => p || rev.repoRoot); }
        else if (selectedRepoRef.current === repoRoot && selectedRepoRef.current !== rev.repoRoot) {
          selectedRepoRef.current = rev.repoRoot;
          setRepoPath(rev.repoRoot);
        }
        const h = await call<ConceptHierarchyView>("C11", "conceptHierarchy", { revision: rev.id, summary: true });
        if (selectedRepoRef.current !== rev.repoRoot) return;
        setHierarchyConcepts(h.ok && h.value.version > 0 ? (h.value.summary?.concepts ?? 0) : 0);
      } else {
        setHierarchyConcepts(0);
      }
    } else setError(s.error.message);
    if (l.ok) setWorkspaces(l.value);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const clearRepositoryContext = () => {
    repoGeneration.current += 1;
    resetResponse();
    setBusy(null); setError(null);
    setView(null); setClaimMap({}); setSelection([]); setCellSel([]); setLevel(DEFAULT_LEVEL);
    setHierarchyConcepts(0); setMessages([]); setEvents([]); setDrawer(null); setCode(null);
    setStale(null); setChanges(null); setCardPins(null); setEditorFocus([]); setDismissed(new Set());
    setWs({ version: 0 }); setWsName(""); setExceptions([]); setReplay(null); setOverlays(null);
    setInfo((current) => current ? { ...current, revision: null, concepts: 0, tests: null, allowHosted: false } : null);
  };
  const normalizeRepoPath = (path: string) => path.trim().replace(/[\\/]+$/, "") || path.trim();
  const selectRepository = (path: string, loadExisting = false) => {
    const root = normalizeRepoPath(path);
    setRepoPath(path);
    if (root === selectedRepoRef.current) { if (loadExisting && root) void refresh(root); return; }
    selectedRepoRef.current = root;
    clearRepositoryContext();
    setNotice(root ? "Repository changed. Previous project context was cleared." : null);
    if (loadExisting && root) void refresh(root);
  };

  // F01: Ctrl/Cmd+K opens cross-repository search from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !e.defaultPrevented) { e.preventDefault(); openDialog(() => setSearchOpen(true)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Editor context (VS Code extension): what you are looking at becomes an offered referent. Polled lightly; harmless if no editor is connected.
  const editorRev = info?.revision?.id;
  useEffect(() => {
    if (!editorRev) return;
    let live = true;
    const tick = async () => {
      const r = await call<EditorContext>("C01", "editorContext", { revision: editorRev }); if (live && r.ok) setEditorFocus(r.value.focus);
      const x = await call<ExceptionRow[]>("C24", "listExceptions", {}); if (live && x.ok) setExceptions(x.value);
    };
    void tick();
    const t = window.setInterval(tick, 4000);
    return () => { live = false; window.clearInterval(t); };
  }, [editorRev]);

  const revision = view?.revision ?? info?.revision?.id;
  const changedIds = useMemo(() => new Set(changes?.affectedNodes.map((n) => n.nodeId) ?? []), [changes]);
  const eff = useMemo(() => (view ? effectiveView(view, claimMap) : null), [view, claimMap]);
  const positions = useMemo(() => (view ? basePositions(view) : new Map()), [view]);
  const rendered = useMemo(() => {
    if (!eff) return { nodes: [], edges: [], groups: [] };
    const staleSet = new Set([...eff.stale, ...changedIds]);
    const renderer = rendererForView(eff.view);
    return arrange(renderer.render(eff.view, level, positions, staleSet), eff.view, level, true);
  }, [eff, level, positions, changedIds]);
  const lensDetails = useMemo(() => eff ? rendererForView(eff.view).render(eff.view, MAX_LEVEL, positions, new Set([...eff.stale, ...changedIds])) : undefined, [eff, positions, changedIds]);
  const selectedRender = useMemo(() => selectedAggregates(rendered, selection), [rendered, selection]);
  const nodeById = useMemo(() => new Map((view?.nodes ?? []).map((n) => [n.id, n])), [view]);
  const overlayNodes = useMemo(() => overlayMarks(rendered, nodeById, overlays?.revision === view?.revision ? overlays : null, showTestOverlay, showRuntimeOverlay), [rendered, nodeById, overlays, view, showTestOverlay, showRuntimeOverlay]);
  const overlayEntityIds = useMemo(() => [...new Set((view?.nodes ?? []).flatMap((n) => n.entityRefs))].slice(0, 2000), [view]);
  const viewKey = view ? `${view.id}:${view.version}:${view.revision}` : "";
  useEffect(() => {
    let live = true;
    if (!view || (!showTestOverlay && !showRuntimeOverlay)) { setOverlays(null); setOverlayError(null); setOverlayBusy(false); return; }
    const to = Date.now(), duration = overlayWindowName === "24h" ? 86_400_000 : overlayWindowName === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
    setOverlayBusy(true); setOverlayError(null); setOverlays(null);
    void call<MapOverlays>("C19", "overlays", { revision: view.revision, entityIds: overlayEntityIds, window: { from: Math.max(0, to - duration), to }, layers: { tests: showTestOverlay, runtime: showRuntimeOverlay } }).then((r) => {
      if (!live) return;
      setOverlayBusy(false);
      if (r.ok) setOverlays(r.value); else { setOverlays(null); setOverlayError(r.error.message); }
    });
    return () => { live = false; };
  }, [viewKey, overlayEntityIds, showTestOverlay, showRuntimeOverlay, overlayWindowName, overlayRefresh]);
  const replayNodes = useMemo(() => {
    const entities = new Map((replay?.entities ?? []).map((e) => [e.entityId, e]));
    return new Map((view?.nodes ?? []).flatMap((n) => {
      const hits = n.entityRefs.flatMap((id) => entities.has(id) ? [entities.get(id)!] : []);
      return hits.length ? [[n.id, hits.some((e) => e.errors > 0)] as const] : [];
    }));
  }, [replay, view]);
  const mapReferents = selection.map((id) => ({ id, label: nodeById.get(id)?.label ?? id, source: "map" as const })).filter((r) => nodeById.has(r.id));
  const editorReferents = editorFocus.filter((f) => !dismissed.has(f.entityId) && !selection.some((id) => nodeById.get(id)?.entityRefs.includes(f.entityId))).map((f) => ({ id: `editor:${f.entityId}`, label: f.label, source: "editor" as const }));
  const cardReferents = cardPins ? [{ id: "card:pins", label: `card: ${cardPins.title}`, source: "editor" as const }] : [];
  // A matrix cell stands for the code of its row and its column; the chat panel shows it as a chip like any other referent.
  const cells = useMemo(() => {
    const m = new Map<string, { label: string; ids: string[] }>();
    const mx = view?.matrix;
    if (mx) for (const r of mx.rows) for (const c of mx.cols) m.set(cellKey({ row: r.id, col: c.id }), { label: `${r.label} × ${c.label}`, ids: [...r.entityRefs, ...c.entityRefs] });
    return m;
  }, [view]);
  const cellReferents = cellSel.filter((k) => cells.has(k)).map((k) => ({ id: k, label: cells.get(k)!.label, source: "cell" as const }));
  const referents = [...mapReferents, ...cellReferents, ...cardReferents, ...editorReferents];
  const cellIds = [...new Set(cellReferents.flatMap((r) => cells.get(r.id)!.ids))];
  const pins = selection.length ? [] : [...new Set([...cellIds, ...(cardPins?.ids ?? []), ...editorReferents.map((r) => r.id.slice(7))])].slice(0, 12);

  async function withBusy<T>(label: string, fn: () => Promise<T>) {
    setBusy(label); setError(null); setNotice(null);
    try { return await fn(); } finally { setBusy(null); }
  }
  const failMsg = (r: Extract<ApiResult<unknown>, { ok: false }>) => `${r.error.code}: ${r.error.message}`;

  // ------------------------------------------------------------ repository
  // Indexing and extraction run as background jobs (C07): they return at once, show progress, and can be cancelled.
  const [jobs, setJobs] = useState<JobView[]>([]);
  const handled = useRef(new Set<string>());
  const primed = useRef(false);
  const jobActive = jobs.some((j) => j.state === "QUEUED" || j.state === "RUNNING");
  const runningJob = (kind: string) => jobs.some((j) => j.kind === kind && (j.state === "QUEUED" || j.state === "RUNNING"));
  const indexFb = buttonFeedback({ busy: runningJob("index") });
  const extractFb = buttonFeedback({ className: "secondary", busy: runningJob(MODE_INFO.hierarchy.jobKind) });
  const saveFb = buttonFeedback({ busy: (busy ?? "").startsWith("Saving") });
  const onJobDone = async (j: JobView) => {
    if (j.state === "SUCCEEDED") {
      const warnings = j.result?.warnings ?? [];
      if (j.kind === "index") {
        const v = j.result!.value as RevisionInfo & { delta?: { mode: string; changed: number; removed: number; of: number } };
        const requestedRoot = normalizeRepoPath(j.params.repoPath ?? "");
        const belongsToSelectedRepo = requestedRoot && requestedRoot === selectedRepoRef.current;
        if (requestedRoot && requestedRoot === selectedRepoRef.current && v.repoRoot !== selectedRepoRef.current) {
          selectedRepoRef.current = v.repoRoot;
          setRepoPath(v.repoRoot);
        }
        if (belongsToSelectedRepo) {
          const incremental = warnings.find((warning) => /^(Incremental:|All files unchanged)/.test(warning));
          setNotice(incremental ?? `Indexed ${v.fileCount} files at ${v.id}${warnings.length ? ` — ${warnings.length} warning(s)` : ""}`);
        }
        log("INDEX", v.id);
      } else if (j.kind === "concept-hierarchy") {
        if (j.params.revision !== info?.revision?.id) { await refresh(); return; }
        const v = j.result!.value as ConceptHierarchyView;
        setHierarchyConcepts(v.concepts.length);
        setNotice(`Built the concept hierarchy: ${hierarchySummary(v)}.${warnings.length ? ` ${warnings[0]}` : ""}`);
        log("CONCEPT_HIERARCHY", String(v.concepts.length));
      } else {
        setNotice(`${j.kind} completed.${warnings.length ? ` ${warnings[0]}` : ""}`);
      }
      await refresh();
    } else if (j.state === "CANCELLED") {
      const belongsToSelectedRepo = j.kind === "index"
        ? normalizeRepoPath(j.params.repoPath ?? "") === selectedRepoRef.current
        : j.params.revision === info?.revision?.id;
      if (belongsToSelectedRepo) setNotice(`${j.kind === "index" ? "Indexing" : j.kind === "concept-hierarchy" ? "Concept hierarchy build" : "Concept extraction"} cancelled. Nothing from that run was saved.`);
    } else {
      const belongsToSelectedRepo = j.kind === "index"
        ? normalizeRepoPath(j.params.repoPath ?? "") === selectedRepoRef.current
        : j.params.revision === info?.revision?.id;
      if (belongsToSelectedRepo) setError(`${j.error?.code ?? "FAILED"}: ${j.message}`);
    }
  };
  const syncJobs = async () => {
    const r = await call<JobView[]>("C07", "listJobs", { limit: 10 });
    if (!r.ok) return;
    setJobs(r.value);
    if (!primed.current) { primed.current = true; for (const j of r.value) if (j.state !== "QUEUED" && j.state !== "RUNNING") handled.current.add(j.id); return; }
    for (const j of [...r.value].reverse()) if (j.state !== "QUEUED" && j.state !== "RUNNING" && !handled.current.has(j.id)) { handled.current.add(j.id); await onJobDone(j); }
  };
  useEffect(() => { void syncJobs(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!jobActive) return;
    const t = setInterval(() => void syncJobs(), 700);
    return () => clearInterval(t);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const startJob = async (kind: "index" | "concept-hierarchy") => {
    setError(null); setNotice(null);
    if (kind === "index") setNotice(info?.revision?.repoRoot === selectedRepoRef.current && !!selectedRepoRef.current ? "Checking the repository for file changes; unchanged parses will be reused…" : "Building an initial index for this repository…");
    const r = await call<JobView>("C07", "enqueue", kind === "index" ? { kind, repoPath: repoPath.trim() } : { kind, revision: info?.revision?.id }, uuid());
    if (!r.ok) return setError(failMsg(r));
    await syncJobs();
  };
  const cancelJob = async (j: JobView) => {
    const r = await call<{ job: JobView; cancelled: boolean; reason?: string }>("C07", "cancelJob", { jobId: j.id }, uuid());
    if (!r.ok) return setError(failMsg(r));
    if (!r.value.cancelled && r.value.reason) setNotice(r.value.reason);
    await syncJobs();
  };
  const index = () => void startJob("index");
  const extract = () => void startJob(MODE_INFO.hierarchy.jobKind);
  const toggleHosted = async (allow: boolean) => {
    const root = info?.revision?.repoRoot;
    if (!root) return;
    const r = await call("C03", "setEgress", { repoRoot: root, allow }, uuid());
    if (!r.ok) return setError(failMsg(r));
    setNotice(allow ? "Hosted model approved for this repository. Every send is logged." : "Hosted model blocked; the offline model will answer.");
    await refresh();
  };
  const openAudit = async () => {
    const r = await call<{ events: AuditEvent[]; chain: { ok: boolean } }>("C03", "auditLog", { limit: 60 });
    if (r.ok) setAudit(r.value); else setError(failMsg(r));
  };

  // ------------------------------------------------------------ views
  function adoptView(v: ViewSpec, claims: Claim[], keepSelection: boolean) {
    const workspace = responseWorkspace.current();
    if (workspace && !workspace.tabs.some((t) => t.view?.id === v.id && t.view.revision === v.revision)) resetResponse();
    mergeClaims(claims);
    setSelection((sel) => (keepSelection ? sel.filter((id) => v.nodes.some((n) => n.id === id)) : []));
    setView(v); setDrawer(null); setCode(null); setStale(null); setCellSel([]);
    if (!keepSelection) setDrawMode("matrix");
    if (v.terrain) setTerrainWeights(Object.fromEntries(v.terrain.factors.map((f) => [f.id, f.weight])));
    if (!keepSelection) { setLevel(v.level ?? DEFAULT_LEVEL); setFitTick((t) => t + 1); setChanges(null); }
  }

  const appendChartMessage = (question: string, response: string, message: Omit<Message, "role" | "alternatives">, routeAlternatives: { form: string; kind?: string; name: string }[] = []) => {
    const id = uuid();
    const alternatives = routeAlternatives.map((option) => ({ ...option, question }));
    setMessages((current) => [...current, { ...message, id, role: "assistant" as const, alternatives }].slice(-200));
    const manifest = responseWorkspace.current()?.manifest;
    if (manifest) {
      const alternatives = manifest.views.filter((v) => v.relevant && !v.primary && v.status !== "unavailable").slice(0, 6).map((v) => ({
        form: v.form, name: v.label, question: manifest.question, ...(v.code.startsWith("S") ? { chartCode: v.code } : {}),
      }));
      if (alternatives.length) setMessages((current) => current.map((item) => item.id === id ? { ...item, alternatives } : item));
    }
  };

  const send = async (text: string) => {
    const command = text.trim().toLowerCase();
    if (/^(go back|back|zoom out|go up|show parent view)$/.test(command)) { navigateBack(); return; }
    if (/^(zoom in|zoom into (?:this|it|selected))$/.test(command)) { setExploreOpen(true); setNotice(exploreTarget ? `Choose a perspective on ${exploreTarget.label}.` : "Select one source-backed element to explore."); return; }
    if (exploreOpen && /^[a-g]$/.test(command) && exploreTarget) { const choice = exploreChoices[command.charCodeAt(0) - 97]; if (choice) explore(choice); return; }
    const responseToken = ++responseGeneration.current;
    responseWorkspace.cancel();
    chatRestoreGeneration.current++;
    const generation = repoGeneration.current;
    say("user", text);
    setBusy("Thinking…"); setError(null); setNotice(null);
    try {
      const r = await call<ConverseResult>("C15", "converse", { text, sessionId: chatSessionId, view, selection, revision: info?.revision?.id, pins });
      if (generation !== repoGeneration.current || responseToken !== responseGeneration.current) return;
      if (!r.ok) { say("assistant", failMsg(r), true); return; }
      const v = r.value;
      for (const w of r.metadata.warnings) say("assistant", `Note: ${w}`);
      switch (v.kind) {
        case "analysis": {
          const shown = v.results.filter((r) => r.view);
          for (const result of shown) mergeClaims(result.claims);
          const last = shown.at(-1);
          if (v.manifest) responseWorkspace.begin(v.manifest, shown.flatMap((r) => r.view ? [{ view: r.view, claims: r.claims }] : []));
          else if (last?.view) adoptView(last.view, last.claims, false);
          const summary = [v.message, ...v.results.flatMap((result) => result.view ? [result.title, result.view.caption, ...result.view.nodes.slice(0, 30).map((node) => `${node.label}: ${(node.notes ?? []).join(" ")}`)] : [result.title, result.message])].join("\n");
          appendChartMessage(text, summary, { text: v.message, at: now(), results: v.results, ...(v.thinking ? { thinking: v.thinking } : {}) });
          log("ASK", text.slice(0, 80));
          break;
        }
        case "view": {
          if (v.manifest) responseWorkspace.begin(v.manifest, [{ view: v.view, claims: v.claims }]);
          else adoptView(v.view, v.claims, !!view && view.id === v.view.id);
          const summary = [v.message, v.view.caption, ...v.view.nodes.slice(0, 40).map((node) => `${node.label}: ${(node.notes ?? []).join(" ")}`), ...v.view.edges.slice(0, 40).map((edge) => `${edge.fromNodeId} ${edge.label ?? edge.kind} ${edge.toNodeId}`)].join("\n");
          appendChartMessage(v.view.question, summary, { text: v.message, at: now(), ...(v.thinking ? { thinking: v.thinking } : {}), ...(v.view.formId === "SemanticMap" ? { providerWizard: true } : {}) }, v.view.route?.alternatives);
          log("ASK", text.slice(0, 80)); break;
        }
        case "explanation": mergeClaims(v.explanation.claims); setDrawer({ kind: "explain", data: v.explanation }); say("assistant", v.message); log("EXPLAIN", text.slice(0, 80)); break;
        case "zoom": if (v.direction === "out") navigateBack(); else if (v.direction === "in") setExploreOpen(true); else void askForm("Show the overall system", "SemanticMap"); break;
        case "resume": say("assistant", v.message); await resume(v.workspaceId); break;
        case "message": say("assistant", v.message); break;
      }
    } finally { if (generation === repoGeneration.current && responseToken === responseGeneration.current) setBusy(null); }
  };

  const showChatResult = (result: ChatAnalysisResult) => {
    if (!result.view) return;
    adoptView(result.view, result.claims, false);
    const count = result.view.nodes.length;
    const message = count ? `Showing ${result.title}: ${count} chart element(s). Click an element to inspect its code and evidence.` : `${result.title} has no chart elements to show; check the gaps listed below the canvas.`;
    setNotice(message);
    setAnnouncement(message);
  };

  // ------------------------------------------------------------ inspection
  async function evidence(ids: string[]): Promise<ResolvedEvidence[]> {
    if (!revision) return [];
    const out = await Promise.all(ids.slice(0, 4).map((id) => call<ResolvedEvidence>("C18", "evidence", { revision, evidenceId: id })));
    return out.flatMap((r) => (r.ok ? [r.value] : []));
  }
  const inspectNode = async (n: RenderNode) => {
    if (n.kind === "ext") {
      setDrawer({ kind: "inspect", title: n.label, sub: "external dependency", notes: ["Imported from outside this repository; the code of the package is not analysed."], claimIds: [], evidence: await evidence(n.evidenceIds ?? []) });
      return;
    }
    if (n.kind === "agg") {
      setSelection(n.members);
      setAnnouncement(`Selected the group ${n.label}; opened its ${n.count} member elements.`);
      setDrawer({ kind: "inspect", title: n.label, sub: `${n.count} element(s) collapsed at level ${level}`, notes: [`Hover with the lens to see these elements individually. Pin the lens to select a member. Selecting this selects all ${n.count}.`], claimIds: [], evidence: [], members: n.members.map((m) => nodeById.get(m)?.label ?? m) });
      return;
    }
    setSelection(n.members);
    setAnnouncement(`Selected ${n.label}; opened its code and evidence details.`);
    await openNodeDrawer(n.node!);
  };
  const openNodeDrawer = async (vn: ViewNode) => {
    const mark = [...overlayNodes.entries()].flatMap(([renderId, value]) => rendered.nodes.find((n) => n.id === renderId)?.members.some((id) => nodeById.get(id)?.entityRefs.some((entity) => vn.entityRefs.includes(entity))) ? [value] : [])[0];
    const evidenceIds = [...new Set([...vn.evidenceIds, ...(mark?.evidenceIds ?? [])])];
    setDrawer({ kind: "inspect", title: vn.label, sub: `${vn.role ?? vn.kind}${vn.file ? ` · ${vn.file}` : ""}`, notes: [...(vn.notes ?? []), ...(mark ? [mark.summary, ...mark.notes] : [])], factors: vn.factors, claimIds: vn.claimIds, evidence: await evidence(evidenceIds), entityId: vn.entityRefs[0] });
    log("INSPECT", vn.label);
  };
  const askForm = async (question: string, form: string, subject?: string, kind?: string, chatLabel?: string, baseQuestion?: string, chartCode?: string, target?: { revision: string; seeds: string[]; scope: "subject" }) => {
    const related = !target && responseWorkspace.workspace?.tabs.find((t) => chartCode ? t.code === chartCode : t.form === form);
    if (related && (baseQuestion || question === responseWorkspace.workspace?.manifest.question)) { void responseWorkspace.generate(related.id); return; }
    const responseToken = ++responseGeneration.current;
    responseWorkspace.cancel();
    const generation = repoGeneration.current;
    say("user", chatLabel ?? question);
    setBusy("Composing view…"); setError(null); setNotice(null);
    try {
      const r = await call<{ view: ViewSpec; claims: Claim[]; manifest?: ResponseManifest }>("C19", "ask", { question, revision: target?.revision ?? info?.revision?.id, form, subject, kind, ...(target ? { seeds: target.seeds, scope: target.scope } : {}), ...(chartCode ? { chartCode } : {}) });
      if (generation !== repoGeneration.current || responseToken !== responseGeneration.current) return;
      if (!r.ok) { say("assistant", failMsg(r), true); return; }
      if (r.value.manifest) responseWorkspace.begin(r.value.manifest, [{ view: r.value.view, claims: r.value.claims }]);
      else adoptView(r.value.view, r.value.claims, !!view && view.id === r.value.view.id);
      const summary = [r.value.view.caption, ...r.value.view.nodes.slice(0, 40).map((node) => `${node.label}: ${(node.notes ?? []).join(" ")}`), ...r.value.view.edges.slice(0, 40).map((edge) => `${edge.fromNodeId} ${edge.label ?? edge.kind} ${edge.toNodeId}`)].join("\n");
      appendChartMessage(baseQuestion ?? question, summary, { text: `${r.value.view.formReason ?? ""} ${r.value.view.caption}`.trim(), at: now() });
      log("ASK", `${form}: ${question.slice(0, 60)}`);
    } finally { if (generation === repoGeneration.current && responseToken === responseGeneration.current) setBusy(null); }
  };
  const inspectCell = async (cell: MatrixCell | null, row: MatrixAxis, col: MatrixAxis, additive = false) => {
    if (!view?.matrix) return;
    const key = cellKey({ row: row.id, col: col.id });
    // Space, or a modifier-click, adds the cell to what "these" means in chat; a plain click inspects it alone.
    if (additive) { setCellSel((s) => (s.includes(key) ? s.filter((x) => x !== key) : [...s, key])); return; }
    setCellSel([key]);
    if (!cell) {
      setDrawer({ kind: "inspect", title: `${row.label} × ${col.label}`, sub: "no relation found", notes: [view.matrix.emptyMeaning], claimIds: [], evidence: [] });
      return;
    }
    const st = view.matrix.states[cell.state];
    setDrawer({ kind: "inspect", title: `${row.label} × ${col.label}`, sub: `${st?.label ?? cell.state} · ${cell.displayMode === "FACT" ? "Fact · statically proven" : cell.displayMode === "HYPOTHESIS" ? "Hypothesis · cannot be proven statically" : "Inference · derived from cited evidence"}`, notes: [cell.note, ...(st ? [st.description] : [])], claimIds: cell.claimId ? [cell.claimId] : [], evidence: await evidence(cell.evidenceIds) });
  };
  const openConsequence = async (id: string) => {
    const c = view?.consequences?.find((x) => x.id === id);
    if (!c) return;
    setDrawer({ kind: "inspect", title: c.kind, sub: `${c.displayMode === "HYPOTHESIS" ? "Hypothesis" : "Inference"} · what this means`, notes: [c.text], claimIds: c.claimId ? [c.claimId] : [], evidence: await evidence(c.evidenceIds) });
    if (c.entityIds?.length) setSelection(view!.nodes.filter((n) => n.entityRefs.some((e) => c.entityIds!.includes(e))).map((n) => n.id).slice(0, 12));
  };
  const inspectEdge = async (e: RenderEdge) => {
    if (!view) return;
    const under = view.edges.filter((x) => e.edgeIds.includes(x.id));
    const first = under[0];
    const lab = (id: string) => nodeById.get(id)?.label ?? id;
    const title = e.count > 1 ? `${e.count} links` : first ? `${lab(first.fromNodeId)} → ${lab(first.toNodeId)}` : "link";
    const how = e.displayMode === "FACT" ? "Fact · statically proven" : e.displayMode === "HYPOTHESIS" ? "Hypothesis · cannot be proven statically" : "Inference · derived from cited evidence";
    setDrawer({ kind: "inspect", title, sub: `${first?.kind ?? "link"} · ${how}`, notes: e.count > 1 ? under.slice(0, 6).map((u) => `${lab(u.fromNodeId)} → ${lab(u.toNodeId)}${u.label ? ` (${u.label})` : ""}`) : [], claimIds: [...new Set(under.map((u) => u.claimId).filter((c): c is string => !!c))], evidence: await evidence(e.evidenceIds) });
  };
  // ------------------------------------------------------------ verdicts
  const verdict = async (claim: Claim, v: VerdictKind, explanation: string): Promise<string | null> => {
    const r = await call<{ claim: Claim; affected: Claim[] }>("C18", "verdict", { claimId: claim.draft.id, verdict: v, explanation, expectedVersion: claim.version }, uuid());
    if (!r.ok) return r.error.code === "VERSION_CONFLICT" ? "This claim changed since you loaded it. Re-run the question to refresh." : r.error.message;
    mergeClaims([r.value.claim, ...r.value.affected]);
    log("VERDICT", `${v} ${claim.draft.id}`);
    say("assistant", v === "REFUTE"
      ? `Refuted. It is now hidden${r.value.affected.length ? ` and ${r.value.affected.length} dependent claim(s) are marked stale` : ""}.`
      : v === "CONFIRM" ? "Confirmed. It stays labelled as an inference: a confirmation is your judgment, not static proof." : "Disputed. It is shown as a hypothesis until resolved.");
    return null;
  };
  const claimsFor = (ids: string[]) => ids.map((id) => claimMap[id]).filter((c): c is Claim => !!c);

  // ------------------------------------------------------------ investigations
  const save = () => withBusy("Saving…", async () => {
    const ids = new Set<string>([...(view?.nodes.flatMap((n) => n.claimIds) ?? []), ...(view?.edges.flatMap((e) => (e.claimId ? [e.claimId] : [])) ?? [])]);
    const state: SavedState = {
      question: view?.question ?? "", view, claims: [...ids].map((id) => claimMap[id]).filter((c): c is Claim => !!c),
      selection: selection.flatMap((id) => nodeById.get(id)?.entityRefs ?? []), explanation: drawer?.kind === "explain" ? drawer.data : null, events, messages,
    };
    const name = wsName || view?.question || "Untitled investigation";
    const r = await call<{ workspaceId: string; receipt: { resourceVersion: number } }>("C13", "saveWorkspace", { workspaceId: ws.id, name, expectedVersion: ws.version, revision, state }, uuid());
    if (!r.ok) return setError(r.error.code === "VERSION_CONFLICT" ? "This investigation was saved elsewhere since you opened it. Re-open it before saving." : failMsg(r));
    setWs({ id: r.value.workspaceId, version: r.value.receipt.resourceVersion });
    setNotice(`Saved “${name}” (v${r.value.receipt.resourceVersion})`);
    await refresh();
  });

  async function resume(id: string) {
    const r = await call<WorkspaceOpen>("C13", "openWorkspace", { workspaceId: id });
    if (!r.ok) { setError(failMsg(r)); return; }
    const s = r.value.state;
    mergeClaims([...s.claims, ...(s.explanation?.claims ?? []), ...(r.value.claimStates ?? [])]);
    setWs({ id: r.value.id, version: r.value.version }); setWsName(r.value.name);
    setView(s.view); setEvents(s.events); setMessages(s.messages ?? []); setLevel(DEFAULT_LEVEL); setCode(null);
    setDrawer(s.explanation ? { kind: "explain", data: s.explanation } : null);
    setSelection((s.view?.nodes ?? []).filter((n) => n.entityRefs.some((e) => s.selection.includes(e))).map((n) => n.id));
    setStale(r.value.staleEvidence.length ? { files: r.value.staleFiles, evidence: r.value.staleEvidence.length } : null);
    log("RESUME", r.value.name);
    // Beat 6: report what changed in the repository since the investigation was saved.
    setChanges(null);
    if (r.value.revisionIndexed) {
      setBusy("Checking what changed since you left…");
      const c = await call<ChangesSince>("C13", "changesSince", { workspaceId: id }, uuid());
      setBusy(null);
      if (c.ok) { setChanges(c.value); say("assistant", `Restored “${r.value.name}”. ${c.value.summary}`); if (!c.value.changed) setStale(null); }
      else say("assistant", `Restored “${r.value.name}”. Couldn't check for repository changes: ${c.error.message}`);
    } else say("assistant", `Restored “${r.value.name}” exactly as saved.`);
    await refresh();
  }

  const refreshOnLatest = () => withBusy("Refreshing on the latest revision…", async () => {
    if (!view || !changes) return;
    const inv = view.investigation;
    const r = inv
      ? await call<{ view: ViewSpec; claims: Claim[] }>("C19", "investigate", { trace: inv.trace, ignored: inv.ignored, revision: changes.toRevision })
      : await call<{ view: ViewSpec; claims: Claim[] }>("C19", "ask", { question: view.question, revision: changes.toRevision });
    if (!r.ok) return setError(failMsg(r));
    adoptView(r.value.view, r.value.claims, true);
    setChanges(null);
    say("assistant", "Refreshed this investigation on the latest code. Your selection and identities were kept where the elements still exist.");
  });

  const investigateException = (x: ExceptionRow) => void send(x.trace);
  const dismissException = async (x: ExceptionRow) => {
    const r = await call("C24", "dismissException", { id: x.id }, uuid());
    if (r.ok) setExceptions((e) => e.filter((y) => y.id !== x.id)); else setError(failMsg(r));
  };
  const override = async (entityId: string, mode: "pin" | "boost" | "demote" | null) => {
    const r = await call("C19", "setOverride", { revision, entityId, mode }, uuid());
    if (!r.ok) return setError(failMsg(r));
    if (view) {
      const f = await call<{ view: ViewSpec; claims: Claim[] }>("C19", "refresh", { view });
      if (f.ok) adoptView(f.value.view, f.value.claims, true);
    }
    say("assistant", mode === "pin" ? "Pinned: it will always be shown." : mode === "boost" ? "Boosted: it ranks higher." : mode === "demote" ? "Demoted: it ranks lower." : "Reset to its computed relevance.");
  };
  const levelsApply = !!view && semanticLevelsApply(view);
  const dm = (m: string) => (m === "FACT" ? "fact" : m === "INFERENCE" ? "inference" : m === "FOG" ? "fog" : "hyp");
  const pending = !!busy || jobActive;
  const phase = canvasPhase({ hasView: !!view, pending });
  const indexed = !!info?.revision;

  // UX-07: auto-collapse repo section once after indexing completes
  useEffect(() => {
    if (indexed && !repoAutoCollapsed) {
      setRepoExpanded(false);
      setRepoAutoCollapsed(true);
    }
  }, [indexed, repoAutoCollapsed]);

  return (
    <div className="app">
      {picking && <FolderPicker initialPath={repoPath} onClose={() => setPicking(false)} onPick={(p) => { selectRepository(p, true); setPicking(false); log("PICK_REPO", p); }} />}
      {galleryOpen && <VisualsGallery revision={info?.revision?.id} onClose={() => setGalleryOpen(false)} onShow={(it: CatalogEntry, q: string) => { setGalleryOpen(false); void askForm(q, it.formId, undefined, undefined, undefined, undefined, selectedChartId(it)); }} />}
      {providerWizardOpen && <ProviderWizard revision={info?.revision?.id} onClose={() => setProviderWizardOpen(false)} />}
      {outlineOpen && <Outline rendered={rendered} level={level} onClose={() => setOutlineOpen(false)} onPick={(id) => { const n = rendered.nodes.find((x) => x.id === id); setOutlineOpen(false); if (n) void inspectNode(n); }} />}
      {browsingHierarchy && (
        <ConceptHierarchyBrowser revision={info?.revision?.id} jobs={jobs} onShowJobs={() => openDialog(() => setJobsOpen(true))} onClose={() => { setBrowsingHierarchy(false); void refresh(); }}
          onAsk={(p) => { setCardPins(p); setBrowsingHierarchy(false); say("assistant", `Referring to “${p.title}” (${p.ids.length} element(s)). Ask your question; they are in the context.`); }} />
      )}
      {jobsOpen && (
        <Modal title="Background work" onClose={() => setJobsOpen(false)} actions={<><span className="muted small">Indexing and extraction run in the background; nothing is saved from a cancelled or interrupted run.</span><button onClick={() => setJobsOpen(false)}>Done</button></>}>
          <JobBar jobs={jobs} onCancel={(j) => void cancelJob(j)} />
          {jobs.length === 0 ? <p className="muted">No jobs yet.</p> : (
            <ul className="dirs" tabIndex={0} aria-label="Recent jobs">
              {jobs.map((j) => <li key={j.id}><span className="mono">{j.kind}</span><span className="muted small">{j.state.toLowerCase()}{j.message ? ` — ${j.message}` : ""}</span></li>)}
            </ul>
          )}
        </Modal>
      )}
      {audit && (
        <Modal title="Audit log" onClose={() => setAudit(null)} actions={<><span className="muted small">Local, hash-chained. Source code is never written here.</span><button onClick={() => setAudit(null)}>Done</button></>}>
          <p><span className={`badge ${audit.chain.ok ? "fact" : "warn"}`}>{audit.chain.ok ? "chain intact" : "chain broken"}</span></p>
          <ul className="dirs" tabIndex={0} aria-label="Audit events">{audit.events.map((e) => <li key={e.seq}><span className="mono">{e.ts.slice(11, 19)} {e.action}</span><span className="muted small">{e.resource.slice(0, 40)}</span></li>)}</ul>
        </Modal>
      )}
      <header>
        {defectsOpen && revision && <DefectPanel revision={revision} onClose={() => setDefectsOpen(false)} />}
        {prOpen && repoPath && <PrPanel repoPath={repoPath} onClose={() => setPrOpen(false)} />}
        {profilesOpen && <ProfilePanel revision={revision ?? null} onClose={() => setProfilesOpen(false)} />}
        {tasksOpen && <TaskPanel revision={revision ?? null} onClose={() => setTasksOpen(false)} />}
        {buildOpen && (
          <BuildFeature
            key={buildContext?.requestId ?? buildContext?.releaseId ?? "default"}
            onClose={() => { setBuildOpen(false); setBuildContext(null); }}
            api={info?.revision?.repoRoot ? { repositoryId: info.revision.repoRoot, call: call as never } : undefined}
            releaseId={buildContext?.releaseId}
            initialRequestId={buildContext?.requestId}
          />
        )}
        {campaignsOpen && <CampaignPanel onClose={() => setCampaignsOpen(false)} />}
        {releasesOpen && <ReleaseWizardPanel onClose={() => setReleasesOpen(false)} onOpenLens={(releaseId) => { setReleasesOpen(false); setLensReleaseId(releaseId); setLensOpen(true); }} />}
        {boardOpen && (
          <ReleaseBoardPanel
            onClose={() => setBoardOpen(false)}
            onOpenRequest={(requestId) => { setBoardOpen(false); setBuildContext({ requestId }); setBuildOpen(true); }}
            onOpenNew={(releaseId) => { setBoardOpen(false); setBuildContext({ releaseId }); setBuildOpen(true); }}
          />
        )}
        {lensOpen && <ReleaseLensPanel releaseId={lensReleaseId} onClose={() => { setLensOpen(false); setLensReleaseId(undefined); }} onOpenScope={() => { setLensOpen(false); setLensReleaseId(undefined); setReleasesOpen(true); }} />}
        {searchOpen && repoPath && <SearchPanel repoPath={repoPath} revision={revision} onClose={() => setSearchOpen(false)} />}
        {hotspotsOpen && repoPath && <HotspotPanel repoPath={repoPath} revision={revision} onClose={() => setHotspotsOpen(false)} />}
        {insightsOpen && revision && <InsightsPanel revision={revision} view={view} onClose={() => setInsightsOpen(false)} onAsk={askFromInsights} onReindexed={refresh} />}
        {investigationsOpen && revision && <InvestigationPanel key={`${revision}:${ws.id ?? "repo"}`} revision={revision} workspaceId={ws.id ?? `repo:${info?.revision?.repoRoot ?? repoPath}`} initialQuestion={view?.question ?? ""} entityRefs={[...new Set(selection.flatMap((id) => nodeById.get(id)?.entityRefs ?? []))]} onClose={() => setInvestigationsOpen(false)} />}
        <h1>Code Intelligence</h1>
        <ModelMenu current={info?.model ?? null} hosted={!!info?.hosted} call={call} onChanged={refresh} />
        {info?.revision && <span className="chip mono" title={info.revision.repoRoot}>rev {info.revision.id} · {info.revision.fileCount} files</span>}
        {hierarchyConcepts > 0 && <span className="chip">{hierarchyConcepts} hierarchy concepts</span>}
        {info?.tests && <span className="chip" title={`Loaded from ${info.tests.found.join(", ")}${info.tests.staleness.length ? `. ${info.tests.staleness.join("; ")}` : ""}`}>tests: {info.tests.tests.passed} pass · {info.tests.tests.failed} fail{info.tests.coverageLinePercent !== null ? ` · ${info.tests.coverageLinePercent}% covered` : ""}{info.tests.staleness.length ? " ⚠" : ""}</span>}
        {busy && <span className="chip busy" role="status">{busy}</span>}
        <nav className="main-nav" aria-label="Main navigation" onClick={(e) => {
          const target = e.target as HTMLElement;
          const menu = target.closest("details.nav-menu");
          if (target.closest("summary")) {
            e.currentTarget.querySelectorAll("details[open]").forEach((item) => { if (item !== menu) item.removeAttribute("open"); });
          } else if (target.closest("button")) {
            e.currentTarget.querySelectorAll("details[open]").forEach((item) => item.removeAttribute("open"));
          }
        }}>
          <details className="nav-menu"><summary>Explore</summary><div className="nav-popover">
            <button className="nav-item" accessKey="k" title="Cross-repository search (Ctrl+K)" aria-keyshortcuts="Ctrl+K" onClick={() => openDialog(() => setSearchOpen(true))}>Search</button>
            <button className="nav-item" onClick={() => openDialog(() => setGalleryOpen(true))}>Visuals</button>
            <button className="nav-item" onClick={() => window.open("/demos/fisheye.html", "_blank", "noopener,noreferrer")}>Fisheye lens demo</button>
          </div></details>
          <details className="nav-menu" aria-disabled={!indexed || undefined}><summary className={indexed ? "" : "nav-disabled"} title={indexed ? undefined : "Index a repository first"}>Health</summary><div className="nav-popover">
            <button className="nav-item" disabled={!revision} onClick={() => openDialog(() => setDefectsOpen(true))}>Defects</button>
            <button className="nav-item" onClick={() => openDialog(() => setHotspotsOpen(true))}>Hotspots</button>
            <button className="nav-item" onClick={() => openDialog(() => setProfilesOpen(true))}>Profiles</button>
            <button className="nav-item" disabled={!revision} onClick={() => openDialog(() => setInsightsOpen(true))}>Insights</button>
            <button className="nav-item" disabled={!revision} onClick={() => openDialog(() => setInvestigationsOpen(true))}>Investigations</button>
          </div></details>
          <details className="nav-menu" aria-disabled={!indexed || undefined}><summary className={indexed ? "" : "nav-disabled"} title={indexed ? undefined : "Index a repository first"}>Work</summary><div className="nav-popover">
            <button className="nav-item" onClick={() => openDialog(() => setPrOpen(true))} title="Analyse a pull request: changed-code findings, the quality gate, and publishing its status to GitHub">Pull requests</button>
            <button className="nav-item" onClick={() => openDialog(() => setTasksOpen(true))}>Tasks</button>
            <button className="nav-item" onClick={() => openDialog(() => setBuildOpen(true))} title="Describe a change, clarify, plan, review the candidate, validate and deliver">Build feature</button>
            <button className="nav-item" onClick={() => openDialog(() => setCampaignsOpen(true))}>Campaigns</button>
          </div></details>
          <details className="nav-menu" aria-disabled={!indexed || undefined}><summary className={indexed ? "" : "nav-disabled"} title={indexed ? undefined : "Index a repository first"}>Releases</summary><div className="nav-popover">
            <button className="nav-item" onClick={() => openDialog(() => setReleasesOpen(true))} title="Freeze what's in a release against a GitHub milestone">New release</button>
            <button className="nav-item" onClick={() => openDialog(() => setBoardOpen(true))} title="Release work for development and QA">Release Board</button>
            <button className="nav-item" onClick={() => openDialog(() => { setLensReleaseId(undefined); setLensOpen(true); })} title="Evidence ledger for release go/no-go">Release Lens</button>
          </div></details>
          <details className="nav-menu settings-menu"><summary aria-label="Settings" title="Settings">⚙</summary><div className="nav-popover">
            <button className="nav-item" onClick={() => openDialog(openAudit)}>Audit log</button>
            <button className="nav-item" aria-pressed={highContrast} onClick={() => setHighContrast(!highContrast)}>High contrast {highContrast ? "✓" : ""}</button>
          </div></details>
        </nav>
      </header>

      <aside className="side" aria-label="Controls" data-collapsed={sideCollapsed ? "true" : undefined}>
        <button
          className="side-toggle"
          onClick={() => setSideCollapsed(!sideCollapsed)}
          aria-label={sideCollapsed ? "Expand controls pane" : "Collapse controls pane"}
          title={sideCollapsed ? "Expand" : "Collapse"}
        >{sideCollapsed ? "▶" : "◀"}</button>
        <section data-indexed={indexed ? "true" : undefined}>
          <h2 style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
            Repository
            {indexed && <span className="badge fact" title={`Indexed: ${info!.revision!.fileCount} files`}>✓ ready</span>}
            <button className="link" style={{fontSize: '11px'}} onClick={() => setRepoExpanded(e => !e)} aria-expanded={repoExpanded} aria-controls="repo-section-body">{repoExpanded ? 'Hide' : 'Show'}</button>
          </h2>
          <div id="repo-section-body" hidden={!repoExpanded}>
          <JobBar jobs={jobs} onCancel={(j) => void cancelJob(j)} />
          <label htmlFor="repo">Repository path</label>
          <input id="repo" value={repoPath} onChange={(e) => selectRepository(e.target.value)} onBlur={() => { if (selectedRepoRef.current) void refresh(selectedRepoRef.current); }} placeholder="" />
          <p className="hint">Example: /home/user/my-project</p>
          <RepositoryGit key={repoPath} repoPath={repoPath} revision={info?.revision ?? null} disabled={!!busy || jobActive} onSwitch={async (git, branch, kind) => {
            await withBusy("Switching branch", async () => {
              const r = await call<RepositoryGitInfo>("C01", "switchBranch", { repoPath: git.repoRoot, branch, kind, expectedHead: git.head, expectedBranch: git.branch });
              if (!r.ok) throw new Error(r.error.message);
              selectedRepoRef.current = normalizeRepoPath(r.value.repoRoot);
              setRepoPath(r.value.repoRoot);
              clearRepositoryContext();
              setNotice(`Switched to ${r.value.branch}. Indexing the checkout…`);
              const indexed = await call<JobView>("C07", "enqueue", { kind: "index", repoPath: git.repoRoot });
              if (!indexed.ok) throw new Error(`Switched to ${branch}, but indexing could not start: ${indexed.error.message}. Click Index to retry.`);
              await syncJobs();
            });
          }} />
          <div className="row">
            <button className="secondary" onClick={() => openDialog(() => setPicking(true))} disabled={!!busy || jobActive}>Browse…</button>
            <button onClick={index} disabled={!repoPath.trim() || !!busy || jobActive} className={indexFb.className} aria-busy={indexFb["aria-busy"]} title={info?.revision?.repoRoot === selectedRepoRef.current ? "Incrementally update the selected repository index" : "Build an initial index for the selected repository"}>{indexFb.spinner && <span className="spinner" aria-hidden="true" />}{info?.revision?.repoRoot === selectedRepoRef.current ? "Update index" : "Index"}</button>
          </div>
          <button className={extractFb.className} onClick={extract} disabled={!info?.revision || !!busy || jobActive} aria-busy={extractFb["aria-busy"]} title={MODE_INFO.hierarchy.help}>{extractFb.spinner && <span className="spinner" aria-hidden="true" />}{MODE_INFO.hierarchy.button}{hierarchyConcepts ? ` (${hierarchyConcepts})` : ""}</button>
          {info?.hosted && info.revision && (
            <div className="egress">
              <label><input type="checkbox" checked={info.allowHosted} onChange={(e) => void toggleHosted(e.target.checked)} /> Allow the hosted model for this repo</label>
              <p className="muted small">{info.allowHosted
                ? "Entity names, file paths, relationship kinds and behavioral facts (throws, writes, topics) for each question are sent to the hosted model. Source code, authors, commit messages and git history never are. Secret-looking names are removed. Every send is logged."
                : "Not approved: answers use the offline model, and nothing leaves this machine."}</p>
            </div>
          )}
          {hierarchyConcepts > 0 && <button className="secondary" onClick={() => openDialog(() => setBrowsingHierarchy(true))}>Browse concept hierarchy</button>}
          </div>
        </section>

        <hr className="side-separator" aria-hidden />

        <section>
          <h2>Exceptions {exceptions.length > 0 && <small>({exceptions.length})</small>}</h2>
          {exceptions.length === 0 ? <p className="muted small">None reported. Apps can send exceptions here with <code>@cie/reporter</code>, or just paste a stack trace into the conversation.</p> : (
            <ul className="exceptions">
              {exceptions.slice(0, 8).map((x) => (
                <li key={x.id}>
                  <div><strong>{x.errorClass}</strong> <span className="chip">{x.count}×</span></div>
                  <div className="muted small">{x.message || "(no message)"} · {x.source}</div>
                  <div className="row"><button className="secondary small" onClick={() => investigateException(x)} disabled={!!busy}>Investigate</button><button className="secondary small" onClick={() => void dismissException(x)}>Dismiss</button></div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>Elements {view && <small>({selection.length} selected)</small>}</h2>
          {phase === "composing" && (!eff || eff.view.nodes.length === 0) ? <Loading pending label="Composing the element list" rows={4} lines={1} /> : !eff || eff.view.nodes.length === 0 ? <p className="muted">Nothing shown yet.</p> : (
            <ul className="elements" tabIndex={0} aria-label="Elements in this view">
              {eff.view.nodes.map((n) => (
                <li key={n.id}>
                  <label>
                    <input type="checkbox" checked={selection.includes(n.id)} onChange={(e) => setSelection(e.target.checked ? [...selection, n.id] : selection.filter((x) => x !== n.id))} />
                    <span className={`dot ${dm(n.displayMode)}`} aria-hidden /> {n.rank ? `#${n.rank} ` : ""}{n.label} <small className="muted">{n.role ?? n.kind}</small>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">Select by clicking, Ctrl-clicking, Box select, or the checkboxes. Selected elements become the “these” in your next message.</p>
        </section>

        <section>
          <h2>Investigation</h2>
          <label className="sr" htmlFor="wsn">Investigation name</label>
          <input id="wsn" value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="Payment failure investigation" />
          <button onClick={save} disabled={!view || !!busy} className={saveFb.className} aria-busy={saveFb["aria-busy"]}>{saveFb.spinner && <span className="spinner" aria-hidden="true" />}{ws.id ? `Save (v${ws.version + 1})` : "Save investigation"}</button>
          <ul className="workspaces">
            {workspaces.map((w) => <li key={w.id}><button className="link" onClick={() => void withBusy("Opening…", () => resume(w.id))}>{w.name}</button> <small className="muted">v{w.version}</small></li>)}
            {workspaces.length === 0 && <li className="muted">No saved investigations.</li>}
          </ul>
        </section>
      </aside>

      <main>
        {responseWorkspace.workspace && <ResponseWorkspaceBar workspace={responseWorkspace.workspace} pending={responseWorkspace.pending}
          canBack={responseWorkspace.canBack} onBack={navigateBack} onSelect={(id) => { if (id === responseWorkspace.workspace?.activeId) return; responseGeneration.current++; setBusy(null); void responseWorkspace.generate(id); }} onClose={responseWorkspace.close}
          onGenerate={() => void responseWorkspace.generateAll()} onCancel={responseWorkspace.cancel} onExport={responseWorkspace.exportResponse}
          onRelate={responseWorkspace.relate} />}
        {responseWorkspace.workspace && <details className="response-findings"><summary>Answer and supporting views</summary>
          {responseWorkspace.workspace.manifest.sections.map((section) => <div key={section.id}><strong>{section.label}</strong><p>{section.text}</p>
            <button className="link small" onClick={() => { const refs = new Set(section.entityRefs); const ids = (view?.nodes ?? []).filter((n) => n.entityRefs.some((id) => refs.has(id))).map((n) => n.id); setSelection(ids); setNotice(ids.length ? `Highlighted ${ids.length} supporting elements.` : "This finding is not represented in the active view. Switch to its supporting tab."); }}>Highlight in this view</button></div>)}
        </details>}
        {!responseWorkspace.waiting && selection.length > 0 && <div className="response-explore"><button className="secondary small" onClick={() => setExploreOpen(!exploreOpen)} aria-expanded={exploreOpen}>Explore selected element</button>
          {exploreOpen && <div className="explore-choices" role="group" aria-label="Explore selected element">
            {exploreTarget ? <><strong>{exploreTarget.label}</strong>{exploreChoices.map((choice, index) => <button key={choice.code} className="secondary small" disabled={choice.disabled} title={choice.reason} onClick={() => explore(choice)}>{String.fromCharCode(65 + index)}. {choice.label}</button>)}
              <button className="secondary small" disabled={exploreTarget.entityRefs.length !== 1} title={exploreTarget.entityRefs.length !== 1 ? "Select a single source entity first" : undefined} onClick={() => void openSource()}>Source</button><button className="link small" onClick={() => { setChatSeed({ text: `Explain ${exploreTarget.label}`, n: Date.now() }); document.getElementById("chat-input")?.focus(); }}>Something else…</button></> : <span>Select one source-backed element; groups or ambiguous selections need a member first.</span>}
          </div>}
        </div>}
        <div className="sr" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
        <p id="canvas-help" className="sr">Keyboard: arrow keys move between elements, Enter inspects, Space selects, E expands the focused element, L pauses or resumes hover expansion, O opens a text outline of the whole map, Escape dismisses the lens or clears the selection.</p>
        {error && <div className="banner error" role="alert">{error} <button className="link" onClick={() => setError(null)}>dismiss</button></div>}
        {notice && <div className="banner ok" role="status">{notice}</div>}
        {changes && changes.changed && (
          <div className="banner warn" role="status">
            {changes.summary}
            {changes.affectedNodes.length > 0 && <> Affected: {changes.affectedNodes.slice(0, 5).map((n) => n.label).join(", ")}{changes.affectedNodes.length > 5 ? "…" : ""}.</>}
            {changes.commits.slice(0, 2).map((c) => <div key={c.file} className="small">• “{c.subject}” by {c.author} ({c.file})</div>)}
            <button className="link" onClick={refreshOnLatest}>Refresh on the latest code</button>
          </div>
        )}
        {stale && !changes?.changed && (
          <div className="banner warn" role="alert">Source changed since this was saved ({stale.files.join(", ")}). {stale.evidence} evidence span(s) may no longer match — treat affected claims as stale.</div>
        )}
        {!responseWorkspace.waiting && (view?.formId === "RuntimeOverlay" || (view && !view.matrix && !view.terrain) || view?.formId === "ChangeRisk" || view?.matrix || view?.consequences) && (
          <details className="viewctrls" open={viewCtrlOpen} onToggle={(e) => setViewCtrlOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary className="viewctrls-toggle">View controls</summary>
            <div className="viewctrls-body">
              <div className="caption">
                {view ? view.caption : phase === "composing" ? COMPOSING_CAPTION : indexed ? "" : EMPTY_NO_INDEX}
                {view?.formReason && <div className="reason muted small">{view.formReason}</div>}
                {view?.params?.chartId && <div className="chart-id-chip small" role="note" aria-label={`Chart type: ${view.params.chartId}`}><span className="badge inference">{String(view.params.chartId)}</span></div>}
                {view?.route && view.route.source !== "chosen" && (
                  <div className={`readas small ${view.route.confidence}`} role="group" aria-label="How your question was read">
                    <span><strong>I read this as: {view.route.name}.</strong> {view.route.confidence === "low" ? "I wasn't sure. " : ""}<span className="muted">{view.route.because}</span></span>
                    {view.route.confidence === "low" && view.route.alternatives.length === 0 && <button className="secondary small" onClick={() => setGalleryOpen(true)}>Choose a view…</button>}
                    {view.route.alternatives.length > 0 && <span className="alts"><span className="muted">Or show it as</span>{view.route.alternatives.map((a) => <button key={a.form + (a.kind ?? "")} className="secondary small" onClick={() => void askForm(view.question, a.form, undefined, a.kind)}>{a.name}</button>)}</span>}
                  </div>
                )}
              </div>
              {view?.formId === "RuntimeOverlay" && (
                <div className="formctl" role="group" aria-label="Time window">
                  <span className="muted small">Window</span>
                  {["24h", "7d", "all"].map((w) => <button key={w} className={`secondary small ${view.params?.subject === w ? "on" : ""}`} aria-pressed={view.params?.subject === w} onClick={() => void askForm(view.question, "RuntimeOverlay", w)}>{w === "all" ? "everything" : `last ${w}`}</button>)}
                </div>
              )}
              {view?.formId === "RuntimeOverlay" && <RuntimeReplay key={viewKey} revision={view.revision} onFrame={setReplay} />}
              {view && !view.matrix && !view.terrain && (
                <div className="formctl map-overlays" role="group" aria-label="Map overlays">
                  <span className="muted small">Overlay</span>
                  <button className={`secondary small ${showTestOverlay ? "on" : ""}`} aria-pressed={showTestOverlay} onClick={() => setShowTestOverlay((v) => !v)}>Test confidence</button>
                  <button className={`secondary small ${showRuntimeOverlay ? "on" : ""}`} aria-pressed={showRuntimeOverlay} onClick={() => setShowRuntimeOverlay((v) => !v)}>Recorded runtime</button>
                  {showRuntimeOverlay && <label className="small">Window <select aria-label="Overlay runtime window" value={overlayWindowName} onChange={(e) => setOverlayWindowName(e.target.value as typeof overlayWindowName)}><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option></select></label>}
                  {(showTestOverlay || showRuntimeOverlay) && <button className="link small" disabled={overlayBusy} onClick={() => setOverlayRefresh((n) => n + 1)}>Refresh overlays</button>}
                  {overlayBusy && <span className="muted small" role="status">Loading overlay data…</span>}
                  {overlayError && <span className="warn-text small" role="alert">{overlayError}</span>}
                  {showTestOverlay && <span className="overlay-legend" aria-label="Test overlay legend"><span className="test-low">Low line coverage</span> · <span className="test-covered">Coverage measured</span> · <span className="test-failing">Mapped test failing</span> · no data is grey</span>}
                  {showRuntimeOverlay && <span className="overlay-legend" aria-label="Runtime overlay legend"><span className="runtime-observed">Recorded spans</span> · <span className="runtime-errors">Recorded errors</span> · no matching spans is grey</span>}
                  {(showTestOverlay || showRuntimeOverlay) && overlays && <span className="muted small">Signal markings decorate drawn nodes. Inspect a node for counts and evidence. {overlays.withheld ? "Some overlay information was withheld or unavailable under current access." : ""}</span>}
                </div>
              )}
              {view?.formId === "ChangeRisk" && (
                <div className="formctl" role="group" aria-label="Kind of change">
                  <span className="muted small">Weighted for</span>
                  {[["default", "any change"], ["security", "security work"], ["refactor", "a refactor"], ["incident", "an incident"]].map(([k, l]) => <button key={k} className={`secondary small ${view.params?.subject === k ? "on" : ""}`} aria-pressed={view.params?.subject === k} onClick={() => void askForm(view.question, "ChangeRisk", k)}>{l}</button>)}
                </div>
              )}
              {view?.matrix && (
                <div className="formctl" role="group" aria-label="How to draw this">
                  <span className="muted small">Draw as</span>
                  <button className={`secondary small ${drawMode === "matrix" ? "on" : ""}`} aria-pressed={drawMode === "matrix"} onClick={() => setDrawMode("matrix")}>Matrix</button>
                  <button className={`secondary small ${drawMode === "graph" ? "on" : ""}`} aria-pressed={drawMode === "graph"} onClick={() => setDrawMode("graph")}>Graph</button>
                </div>
              )}
              {view?.consequences && <Consequences items={view.consequences} onOpen={(id) => void openConsequence(id)} />}
            </div>
          </details>
        )}
        <div id="response-view-panel" role={responseWorkspace.workspace ? "tabpanel" : undefined} aria-labelledby={responseWorkspace.workspace ? `tab-${responseWorkspace.workspace.activeId}` : undefined} className="stage" aria-busy={responseWorkspace.waiting || phase === "composing" ? "true" : undefined}>
          {responseWorkspace.waiting ? <div className="empty-chart-state" role="status"><strong>{responseWorkspace.active?.label}</strong><p>{responseWorkspace.active?.status === "generating" ? "Generating this view from the same question and revision…" : responseWorkspace.active?.reason ?? "Select this tab to generate its view."}</p>{responseWorkspace.active?.status === "failed" && <button onClick={() => void responseWorkspace.generate(responseWorkspace.active!.id)}>Retry this view</button>}</div> : view?.matrix && drawMode === "matrix" ? (
            <MatrixView matrix={eff!.view.matrix!} stale={eff!.stale} selected={new Set(cellSel)} onPick={(c, r, k, add) => void inspectCell(c, r, k, add)} />
          ) : view?.terrain ? (
            <TerrainView view={view} weights={terrainWeights} onWeights={setTerrainWeights} selected={new Set(selection)}
              onPick={(id) => { const vn = view.nodes.find((n) => n.id === id); if (vn) { setSelection([id]); void openNodeDrawer(vn); } }}
              onToggle={(id) => setSelection((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]))} />
          ) : (
          <Canvas key={responseWorkspace.workspace?.activeId ?? "legacy"} initialState={canvasRestore} onState={(state) => { canvasSnapshot.current = state; }} rendered={rendered} lensDetails={lensDetails} replayNodes={replayNodes} overlayNodes={overlayNodes} viewKey={viewKey} level={level} fitTick={fitTick} semanticLevels={levelsApply} formId={view?.formId} chartId={typeof view?.params?.chartId === "string" ? view.params.chartId : undefined} selected={selectedRender} boxSelect={boxSelect} caption={view?.caption ?? ""}
            onSelectNodes={(ids) => setSelection([...new Set(rendered.nodes.filter((n) => ids.includes(n.id)).flatMap((n) => n.members))])}
            onTapNode={inspectNode} onTapEdge={inspectEdge}
            onToggleNode={(n) => setSelection((sel) => (n.members.every((m) => sel.includes(m)) ? sel.filter((x) => !n.members.includes(x)) : [...new Set([...sel, ...n.members])]))}
            onClear={() => setSelection([])} onOpenOutline={() => openDialog(() => setOutlineOpen(true))} announce={setAnnouncement} />
          )}
          {!responseWorkspace.waiting && view && ["GeneratedChart", "RouteMap"].includes(view.formId) && rendered.nodes.length === 0 && rendered.edges.length === 0 && (
            <div className="empty-chart-state" role="status" aria-live="polite">
              <strong>{view.caption || "No diagram elements to display"}</strong>
              <p>{view.gaps[0] ?? "No current indexed evidence supports elements for this diagram."}</p>
              {view.gaps.length > 1 && <ul>{view.gaps.slice(1, 4).map((gap, index) => <li key={index}>{gap}</li>)}</ul>}
            </div>
          )}
          {!responseWorkspace.waiting && view && view.nodes.length > 0 && !view.terrain && !(view.matrix && drawMode === "matrix") && (
            <div className="toolbar" role="toolbar" aria-label="Canvas tools">
              <button className={`tool ${boxSelect ? "on" : ""}`} aria-pressed={boxSelect} onClick={() => setBoxSelect(!boxSelect)}>{boxSelect ? "Box select: drag to select (click to stop)" : "Box select"}</button>
              <button className="tool" onClick={() => setOutlineOpen(true)} title="The whole map as text (shortcut: O)">Text outline</button>
              {levelsApply && <span className="levelctl" role="group" aria-label="Level of detail">
                <label>Context <select aria-label="Chart context level" value={level} onChange={(e) => { setLevel(Number(e.target.value)); setFitTick((t) => t + 1); }}>
                  {LEVELS.map((entry, index) => <option key={index} value={index}>L{index} · {entry.name}</option>)}
                </select></label>
              </span>}
            </div>
          )}
          {!view && (phase === "composing" ? <CanvasSkeleton label={COMPOSING_CAPTION} /> : <div className="empty">{emptyStageCopy(indexed)}</div>)}
        </div>
        <footer hidden={responseWorkspace.waiting}>
          {eff && <EpistemicSummary
            elements={view?.matrix && drawMode === "matrix" ? eff.view.matrix!.cells : view?.terrain ? eff.view.nodes.filter((n) => n.tier !== "HIDDEN") : [...rendered.nodes, ...rendered.edges]}
            scope={view?.matrix && drawMode === "matrix" ? "matrix cells" : view?.terrain ? "view nodes" : "drawn nodes and edges"}
            stale={view?.matrix && drawMode === "matrix" ? eff.view.matrix!.cells.filter((c) => eff.stale.has(cellKey(c))).length : view?.terrain ? eff.view.nodes.filter((n) => eff.stale.has(n.id) || changedIds.has(n.id)).length : [...rendered.nodes, ...rendered.edges].filter((n) => n.stale).length} />}
          <ul className="legend">
            {(view?.legend ?? []).map((l) => <li key={l.label}><span className={`swatch ${dm(l.displayMode)}`} aria-hidden /> <strong>{l.label}</strong> — {l.description}</li>)}
          </ul>
          {view && view.gaps.length > 0 && <button className="link footer-toggle" aria-expanded={footerOpen.gaps} aria-controls="footer-more" onClick={() => setFooterOpen((o) => ({ ...o, gaps: !o.gaps }))}>{view.gaps.length} gap(s) in this view</button>}
          {view?.hidden && view.hidden.length > 0 && <button className="link footer-toggle" aria-expanded={footerOpen.hidden} aria-controls="footer-more" onClick={() => setFooterOpen((o) => ({ ...o, hidden: !o.hidden }))}>{view.hidden.length} candidate(s) left out</button>}
          {(footerOpen.gaps || footerOpen.hidden) && (
            <div id="footer-more" className="footer-panel" role="region" aria-label="Gaps and left-out candidates">
              {footerOpen.gaps && view && view.gaps.length > 0 && <section><h3>Gaps in this view</h3><ul>{view.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul></section>}
              {footerOpen.hidden && view?.hidden && view.hidden.length > 0 && <section><h3>Candidates left out</h3><ul>{view.hidden.slice(0, 12).map((h) => <li key={h.entityId}>{h.label}: {h.reason}</li>)}</ul><p className="muted small">Ask “why isn't X shown?” about any of them.</p></section>}
            </div>
          )}
        </footer>
      </main>

      <aside className="right" data-has-evidence={code || drawer ? "true" : "false"}>
        <ChatPanel onNewContext={() => { resetResponse(); setView(null); setSelection([]); setCellSel([]); setCode(null); setDrawer(null); setBusy(null); chatRestoreGeneration.current++; setChatSessionId(uuid()); setMessages([]); setError(null); setNotice("Started a new conversation context."); }} onShowResult={showChatResult} onShowAlt={(alt) => void askForm(alt.prompt ?? alt.question, alt.form, undefined, alt.kind, `Show as ${alt.name}`, alt.question, alt.chartCode)} onCreateProvider={() => openDialog(() => setProviderWizardOpen(true))} messages={messages} referents={referents} busy={!!busy} canAsk={!!info?.revision} examples={EXAMPLES} seed={chatSeed ?? undefined} onSend={(t) => void send(t)} onDropReferent={(id) => (id.startsWith("cell:") ? setCellSel(cellSel.filter((x) => x !== id)) : id === "card:pins" ? setCardPins(null) : id.startsWith("editor:") ? setDismissed(new Set([...dismissed, id.slice(7)])) : setSelection(selection.filter((x) => x !== id)))} />
        <section className="drawer" aria-label="Evidence">
          {code && (
            <div className="codecard">
              <div className="between"><strong>{code.title}</strong><button className="link" onClick={() => setCode(null)}>close</button></div>
              <div className="mono muted small">{code.file}:{code.startLine}</div>
              <pre tabIndex={0} role="group" aria-label={`Code of ${code.title}`}><code>{code.snippet}</code></pre>
            </div>
          )}
          {drawer?.kind === "explain" ? (
            <>
              <h2>Explanation</h2>
              <p>{drawer.data.summary}</p>
              {drawer.data.claims.map((c) => <ClaimCard key={c.draft.id} claim={claimMap[c.draft.id] ?? c} onVerdict={verdict} />)}
              <h3>Evidence</h3>
              {drawer.data.evidence.map((e) => <EvidenceCard key={e.id} e={e} />)}
            </>
          ) : drawer?.kind === "inspect" ? (
            <>
              <h2>{drawer.title}</h2>
              <p className="muted">{drawer.sub}</p>
              {drawer.entityId && (
                <div className="verdicts" role="group" aria-label="Relevance for this element">
                  <button className="secondary small" onClick={() => void override(drawer.entityId!, "pin")} title="Always show this element">Pin</button>
                  <button className="secondary small" onClick={() => void override(drawer.entityId!, "boost")} title="Rank it higher">Boost</button>
                  <button className="secondary small" onClick={() => void override(drawer.entityId!, "demote")} title="Rank it lower">Demote</button>
                  <button className="secondary small" onClick={() => void override(drawer.entityId!, null)} title="Back to computed relevance">Reset</button>
                </div>
              )}
              {drawer.members && <ul className="memberlist">{drawer.members.slice(0, 12).map((m, i) => <li key={i}>{m}</li>)}{drawer.members.length > 12 && <li className="muted">+{drawer.members.length - 12} more</li>}</ul>}
              {drawer.notes.map((n, i) => <p key={i} className="note">{n}</p>)}
              {drawer.factors && <details><summary>Why it is shown (6 factors)</summary><table className="gates"><tbody>{drawer.factors.map((f) => <tr key={f.factor}><th scope="row">{f.factor.replace(/_/g, " ").toLowerCase()}</th><td>{f.normalizedScore.toFixed(2)}</td><td>{f.reason}</td></tr>)}</tbody></table></details>}
              {claimsFor(drawer.claimIds).map((c) => <ClaimCard key={c.draft.id} claim={c} onVerdict={verdict} />)}
              {drawer.evidence.map((e) => <EvidenceCard key={e.id} e={e} />)}
            </>
          ) : !code && <p className="muted">Click an element or edge to see exactly where it comes from. Hover with the lens to expand an element; pin it to inspect its members.</p>}
        </section>
      </aside>
    </div>
  );
}

function EvidenceCard({ e }: { e: ResolvedEvidence }) {
  const code = e.startLine > 0;
  return (
    <figure className="evidence" aria-label={`Evidence: ${e.file}${code ? `:${e.startLine}` : ""}, ${CLASS_LABEL[e.class] ?? e.class}${e.state !== "CURRENT" ? e.state === "STALE" ? ", source changed" : ", unavailable" : ""}`}>
      <figcaption>
        <span className="mono">{e.file}{code ? `:${e.startLine}${e.endLine !== e.startLine ? `–${e.endLine}` : ""}` : ""}</span>
        {e.absPath && <a className="open" href={`vscode://file${e.absPath}:${e.startLine || 1}`} title="Open this location in VS Code">Open in VS Code</a>}
        <span className={`badge ${e.class.startsWith("STATIC") ? "fact" : "inference"}`}>{CLASS_LABEL[e.class] ?? e.class}</span>
        {e.state !== "CURRENT" && <span className="badge warn">{e.state === "STALE" ? "Source changed" : "Unavailable"}</span>}
      </figcaption>
      {e.snippet && <pre tabIndex={0} role="group" aria-label={`Code from ${e.file}`}><code>{e.snippet}</code></pre>}
    </figure>
  );
}
