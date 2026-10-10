// F13 — PR summary and reading-order walkthrough (§1–§16).
//
// A deterministic, cited "what changed and where to start reading" section at the top of the F11 impact comment,
// built from the retained ChangeSet with no model. Counts and change kinds are Fact (read from stored facts of
// both revisions); the reading order and the description-versus-change check are Inference — a stated rule, not a
// proof — and say so at render time.
//
// Every rendered sentence comes from a closed template set keyed by a fact kind (§7.2); a sentence with no backing
// fact cannot be rendered, and `checkSummaryLine` is the pure gate that proves it (§7.6). Attacker-controlled text
// (PR title/body, symbol and file names) is escaped the same way as the F11 comment and never interpolated into a
// sentence template (§10.3–10.4). Denied paths are counted, never named (§10.2).

import type { PrSummary, ReadingFactor } from "@cie/schema";
import type { ChangeSet, Consequence, EntityChange } from "./history.ts";
import { OPEN, type AccessPolicy } from "./access.ts";
import { highImpactHits, classifyTier, PATTERN_LABEL, type ChangedPath } from "./feature/tiers.ts";
import type { Mentions } from "./mentions.ts";
import { isTestPath } from "./execution.ts";
import { escapeForgeText } from "./impact-render.ts";

export const SUMMARY_MARKER = "<!-- cie-summary -->";
export const SUMMARY_BUDGET_BYTES = 3072; // §13
export const MAX_READING_ORDER_LINES = 12; // §13
export const MAX_LIST_LINES = 5; // §13
export const MAX_LINE_BYTES = 400;
/** §7.5 suppression threshold (D4: a value until S0 data exists — stated, not tuned). */
export const MIN_DESCRIPTION_CHARS = 20;
const AUTHOR_EXCERPT_CHARS = 200;

const shortName = (id: string) => id.replace(/^[a-z]+:/, "").replace(/^.*#/, "");
/** Same module derivation as overview.ts (§7.1). */
const moduleOf = (file: string) => {
  const parts = file.split("/");
  return parts.slice(0, Math.min(parts.length - 1, ["src", "apps", "packages"].includes(parts[0]) ? 2 : 1)).join("/") || ".";
};

// ---------------------------------------------------------------- builder input (§6, §7)

export interface PrSummaryInput {
  cs: ChangeSet;
  access?: AccessPolicy;
  /** §9: false when the call graph for the changed set did not finish — the reading order is omitted, never guessed. */
  graphComplete?: boolean;
  /** Untrusted PR title+body (§7.5). */
  descriptionText?: string | null;
  /** Wired to resolveMentions against the head revision; without it the description check cannot run. */
  resolveDescription?: (text: string) => Mentions;
  /** Head-entity lookups injected by the caller (store-backed, deterministic). */
  entityFile?: (headEntityId: string) => string | null;
  /** Direct dependent entity ids of a head entity (call graph, §7.4). */
  dependentsOf?: (headEntityId: string) => readonly string[];
  isEntryPoint?: (headEntityId: string) => boolean;
  /** Structural size of the change for one entity, for the CHANGE_SIZE factor (uncalibrated, §7.4). */
  changeSize?: (headEntityId: string) => number;
}

const KIND_WORD: Record<string, string> = { ADDED: "added", MODIFIED: "modified", REMOVED: "deleted", RENAMED: "relocated", MOVED: "relocated" };
const PATH_KIND: Record<string, ChangedPath["kind"]> = { ADDED: "ADDED", MODIFIED: "MODIFIED", REMOVED: "DELETED", RENAMED: "RENAMED", MOVED: "RENAMED" };

function changedPathsOf(cs: ChangeSet, fileOf: (id: string) => string | null): ChangedPath[] {
  // One entry per changed path; an entity-level RENAMED/MOVED marks its whole path relocated.
  const byPath = new Map<string, ChangedPath["kind"]>();
  const rank: Record<string, number> = { ADDED: 0, MODIFIED: 1, RENAMED: 2, DELETED: 3 };
  for (const e of cs.entities) {
    if (e.change === "UNCHANGED") continue;
    const id = e.head ?? e.base;
    if (!id) continue;
    const path = fileOf(id);
    if (!path) continue;
    const kind = PATH_KIND[e.change] ?? "MODIFIED";
    const cur = byPath.get(path);
    if (!cur || rank[kind] > rank[cur]) byPath.set(path, kind);
  }
  return [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, kind]) => ({ path, kind }));
}

/**
 * §7.2 — structural behaviour wording only when a consequence of that kind names the entity; otherwise the line is
 * just the change kind. The mapping consequence kind → phrase is this closed table, and the consequence text must
 * contain the entity's short name, so a line can never claim behaviour the compare pass did not record.
 */
const BEHAVIOUR_PHRASE: Partial<Record<Consequence["kind"], string>> = {
  TRANSACTION_BYPASS: "now opens a transaction",
  WRITE_REACH_CHANGED: "now writes inside a transaction",
  TRANSACTION_RESTORED: "now writes inside a transaction",
  ERROR_PATH_ADDED: "gains a guard that can throw",
};
export function consequenceNoteFor(entityId: string, cs: ChangeSet): string | null {
  const name = shortName(entityId);
  const kinds = new Set(cs.consequences.filter((c) => c.text.includes(name)).map((c) => c.kind));
  for (const [kind, phrase] of Object.entries(BEHAVIOUR_PHRASE)) if (kinds.has(kind as Consequence["kind"])) return phrase;
  return null;
}

/** §7.5.1 — strip code fences and quoted reply lines; the rest is compared verbatim, still untrusted. */
export function stripDescription(raw: string): string {
  return raw.replace(/```[\s\S]*?```/g, " ").replace(/^\s*>.*$/gm, " ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- reading order (§7.4)

interface FileGroup { path: string; entities: EntityChange[] }

const FACTOR_ORDER: ReadingFactor["name"][] = ["DEPENDED_ON", "ENTRY_POINT", "CHANGE_SIZE", "HIGH_IMPACT"];

function readingOrderOf(
  cs: ChangeSet,
  groups: FileGroup[],
  opts: {
    access: AccessPolicy;
    changedHead: Set<string>;
    entityFile: (id: string) => string | null;
    dependentsOf?: (id: string) => readonly string[];
    isEntryPoint?: (id: string) => boolean;
    changeSize?: (id: string) => number;
    highImpactPaths: Set<string>;
  },
): { lines: PrSummary["readingOrder"]; omitted: number; denied: number } {
  // Per-entity graph facts, computed once; "h is depended on by other changed entities" counts changed dependents.
  const depCount = new Map<string, number>();
  const entryDependents = new Map<string, number>();
  const sizeOf = new Map<string, number>();
  for (const g of groups) {
    for (const e of g.entities) {
      const id = e.head!;
      const deps = opts.dependentsOf?.(id) ?? [];
      depCount.set(id, deps.filter((d) => d !== id && opts.changedHead.has(d)).length);
      entryDependents.set(id, deps.length);
      sizeOf.set(id, Math.max(0, opts.changeSize?.(id) ?? 0));
    }
  }

  const testRank = new Map<string, number>(); // test path → rank of the source file it exercises (best)
  const sourceRank = new Map<string, number>(); // source path → tentative rank among non-test groups

  const catOf = (g: FileGroup): number => {
    if (g.entities.some((e) => (depCount.get(e.head!) ?? 0) > 0)) return 1;
    if (g.entities.some((e) => opts.isEntryPoint?.(e.head!))) return 2;
    return isTestPath(g.path) ? 4 : 3;
  };
  const keyOf = (g: FileGroup, cat: number): number => {
    if (cat === 1) return -Math.max(...g.entities.map((e) => depCount.get(e.head!) ?? 0));
    if (cat === 2) return -Math.max(...g.entities.map((e) => entryDependents.get(e.head!) ?? 0));
    if (cat === 3) return -g.entities.reduce((a, e) => a + (sizeOf.get(e.head!) ?? 0), 0);
    return testRank.get(g.path) ?? Number.MAX_SAFE_INTEGER;
  };

  // Rank source groups first (tests hang off them), then place tests under the source they still reach.
  const sourceGroups = groups.filter((g) => catOf(g) !== 4);
  const sorted = [...sourceGroups].sort((a, b) => {
    const ca = catOf(a), cb = catOf(b);
    if (ca !== cb) return ca - cb;
    const ka = keyOf(a, ca), kb = keyOf(b, cb);
    if (ka !== kb) return ka - kb;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return (a.entities[0]?.head ?? "").localeCompare(b.entities[0]?.head ?? "");
  });
  sorted.forEach((g, i) => sourceRank.set(g.path, i));
  for (const ti of cs.testImpact) {
    const srcFile = opts.entityFile?.(ti.entityId) ?? null;
    const r = srcFile !== null ? sourceRank.get(srcFile) : undefined;
    for (const t of [...ti.unchanged, ...ti.gained]) {
      const file = opts.entityFile?.(t) ?? null;
      if (file === null || r === undefined) continue;
      if ((testRank.get(file) ?? Number.MAX_SAFE_INTEGER) > r) testRank.set(file, r);
    }
  }

  const all = [...sorted, ...groups.filter((g) => catOf(g) === 4)].sort((a, b) => {
    const ca = catOf(a), cb = catOf(b);
    if (ca !== cb) return ca - cb;
    const ka = keyOf(a, ca), kb = keyOf(b, cb);
    if (ka !== kb) return ka - kb;
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return (a.entities[0]?.head ?? "").localeCompare(b.entities[0]?.head ?? "");
  });

  let denied = 0;
  const lines: PrSummary["readingOrder"] = [];
  for (const g of all) {
    if (opts.access.denied(g.path)) { denied++; continue; } // counted, never named (§10.2, F13-A4)
    if (lines.length >= MAX_READING_ORDER_LINES) break;
    const cat = catOf(g);
    const primary = [...g.entities].sort((a, b) => ((depCount.get(b.head!) ?? 0) - (depCount.get(a.head!) ?? 0)) || a.head!.localeCompare(b.head!))[0];
    const why: ReadingFactor[] = [];
    const add = (name: ReadingFactor["name"], value: number) => { if (value > 0) why.push({ name, value }); };
    add("DEPENDED_ON", Math.max(...g.entities.map((e) => depCount.get(e.head!) ?? 0)));
    add("ENTRY_POINT", Math.max(...g.entities.map((e) => entryDependents.get(e.head!) ?? 0)));
    add("CHANGE_SIZE", g.entities.reduce((a, e) => a + (sizeOf.get(e.head!) ?? 0), 0));
    add("HIGH_IMPACT", opts.highImpactPaths.has(g.path) ? 1 : 0);
    why.sort((a, b) => FACTOR_ORDER.indexOf(a.name) - FACTOR_ORDER.indexOf(b.name));
    const names = [...new Set(g.entities.map((e) => shortName(e.head!)))].sort().slice(0, 4);
    const noteParts: string[] = [];
    const behaviour = consequenceNoteFor(primary.head!, cs);
    if (behaviour) noteParts.push(behaviour);
    noteParts.push(`(${KIND_WORD[primary.change] ?? "modified"})`);
    if (cat === 1) noteParts.push("← the change the others depend on");
    else if (cat === 2) noteParts.push(`← entry point, ${Math.max(...g.entities.map((e) => entryDependents.get(e.head!) ?? 0))} dependent(s)`);
    else if (cat === 4) noteParts.push("← tests");
    lines.push({ rank: lines.length + 1, path: g.path, entityIds: g.entities.map((e) => e.head!).sort(), note: noteParts.join(" "), why });
  }
  const omitted = Math.max(0, all.length - denied - lines.length);
  return { lines, omitted, denied };
}

// ---------------------------------------------------------------- description versus change (§7.5)

function compareDescription(
  stripped: string,
  mentions: Mentions,
  changedModules: Map<string, string[]>, // module → representative changed paths
  changedHead: Set<string>,
  changedFiles: Set<string>,
  access: AccessPolicy,
  entityFile: (id: string) => string | null,
): NonNullable<PrSummary["description"]> {
  const mentionedModules = new Set<string>();
  const mentionedNotChanged: { phrase: string }[] = [];
  const seenPhrase = new Set<string>();
  for (const m of mentions.resolved) {
    for (const match of m.matches) {
      const file = entityFile(match.entityId);
      if (file !== null) mentionedModules.add(moduleOf(file));
      const changed = changedHead.has(match.entityId) || (file !== null && changedFiles.has(file));
      if (!changed && !seenPhrase.has(m.text)) { seenPhrase.add(m.text); mentionedNotChanged.push({ phrase: m.text }); }
    }
  }
  // Module-level aggregation: a module with no mention at all is listed once, never per helper (§7.5.3).
  const changedNotMentioned: { path: string }[] = [];
  for (const [mod, paths] of [...changedModules.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (mentionedModules.has(mod)) continue;
    if (paths.every((p) => access.denied(p))) continue; // denied paths are counted via budget.omitted, never named
    changedNotMentioned.push({ path: mod });
  }
  return {
    authorText: stripped,
    changedNotMentioned: changedNotMentioned.slice(0, 50),
    mentionedNotChanged: mentionedNotChanged.slice(0, 50),
    unresolved: mentions.unresolved.slice(0, 50), // listed separately, never claimed as missing (§7.5.4)
    matchedBy: "NAME_MATCH",
  };
}

// ---------------------------------------------------------------- builder (§6, §7.1)

/**
 * Build the PrSummary from the retained ChangeSet (§7). Pure and deterministic: the same ChangeSet and the same
 * injected lookups give byte-identical JSON on any machine (F13-A3). Every injected lookup must be deterministic.
 */
export function buildPrSummary(input: PrSummaryInput): PrSummary {
  const { cs } = input;
  const access = input.access ?? OPEN;
  const graphComplete = input.graphComplete ?? true;
  const fileOf = input.entityFile ?? (() => null);

  const changed = cs.entities.filter((e) => e.change !== "UNCHANGED");
  const changedHead = new Set(changed.map((e) => e.head).filter((h): h is string => !!h));
  let files = 0, modules = 0, testFiles = 0;
  const changedFiles = new Set<string>();
  if (input.entityFile) {
    for (const e of changed) {
      const id = e.head ?? e.base;
      if (!id) continue;
      const f = fileOf(id);
      if (f !== null) changedFiles.add(f);
    }
    files = changedFiles.size;
    modules = new Set([...changedFiles].map(moduleOf)).size;
    testFiles = [...changedFiles].filter(isTestPath).length;
  } else {
    // Without a file lookup the summary still counts entities; files fall back to the compare() text-diff count.
    files = cs.textDiff.filesChanged;
  }

  const counts = {
    files,
    modules,
    added: changed.filter((e) => e.change === "ADDED").length,
    modified: changed.filter((e) => e.change === "MODIFIED").length,
    deleted: changed.filter((e) => e.change === "REMOVED").length,
    renamed: changed.filter((e) => e.change === "RENAMED" || e.change === "MOVED").length,
    testFiles,
  };

  const paths = changedPathsOf(cs, fileOf);
  const tier = classifyTier(paths);

  // §7.3 — high-impact areas from the pattern list; "touches", never "risky".
  const hits = highImpactHits(paths);
  const byPattern = new Map<number, string[]>();
  for (const h of hits) byPattern.set(h.patternId, [...(byPattern.get(h.patternId) ?? []), h.path]);
  const highImpact = [...byPattern.entries()].sort((a, b) => a[0] - b[0]).map(([patternId, ps]) => {
    const label = PATTERN_LABEL[patternId] ?? `pattern #${patternId}`;
    return { area: label, files: ps.length, reason: `matches a high-impact pattern (#${patternId}) — ${label}`, patternId };
  });

  // §7.4 — reading order; omitted entirely when the call graph did not finish (§9, F13-A9).
  let readingOrder: PrSummary["readingOrder"] = [];
  let omitted = 0;
  if (graphComplete && input.entityFile) {
    const groups = new Map<string, FileGroup>();
    for (const e of changed) {
      if (!e.head) continue;
      const f = fileOf(e.head) ?? "(unknown)";
      const g = groups.get(f) ?? { path: f, entities: [] };
      g.entities.push(e);
      groups.set(f, g);
    }
    const highImpactPaths = new Set(hits.map((h) => h.path));
    const order = readingOrderOf(cs, [...groups.values()].sort((a, b) => a.path.localeCompare(b.path)), {
      access,
      changedHead,
      highImpactPaths,
      entityFile: fileOf,
      dependentsOf: input.dependentsOf,
      isEntryPoint: input.isEntryPoint,
      changeSize: input.changeSize,
    });
    readingOrder = order.lines;
    omitted += order.omitted + order.denied;
  }

  // Tests: added/removed test entities and lost reach (from compare().testImpact, §7.1).
  const isTestEntity = (e: EntityChange): boolean => {
    const id = e.head ?? e.base;
    if (!id) return false;
    if (id.startsWith("test:")) return true;
    const f = fileOf(id);
    return f !== null && isTestPath(f);
  };
  const tests = {
    added: changed.filter((e) => e.change === "ADDED" && isTestEntity(e)).length,
    removed: changed.filter((e) => e.change === "REMOVED" && isTestEntity(e)).length,
    lostReach: [...new Set(cs.testImpact.flatMap((t) => t.lost))].sort(),
  };

  // §7.5 — description versus change; suppressed when empty/brief (F13-A7).
  let description: PrSummary["description"] = null;
  const stripped = stripDescription(input.descriptionText ?? "");
  if (stripped.length >= MIN_DESCRIPTION_CHARS && input.resolveDescription) {
    const mentions = input.resolveDescription(stripped);
    // Modules of changed files, excluding rename-only and test-only changes (§7.5.3).
    const changedModules = new Map<string, string[]>();
    for (const f of changedFiles) {
      const ents = changed.filter((e) => (e.head ? fileOf(e.head) : null) === f || (e.base ? fileOf(e.base) : null) === f);
      if (!ents.length) continue;
      if (ents.every((e) => e.change === "RENAMED" || e.change === "MOVED")) continue;
      if (ents.every(isTestEntity)) continue;
      const mod = moduleOf(f);
      changedModules.set(mod, [...(changedModules.get(mod) ?? []), f]);
    }
    description = compareDescription(stripped, mentions, changedModules, changedHead, changedFiles, access, fileOf);
  }

  return {
    schemaVersion: 1,
    counts,
    highImpact,
    readingOrder,
    tests,
    description,
    budget: { renderedBytes: 0, truncated: false, omitted },
    graphComplete,
    docsOnly: tier.tier === "T0",
    alsoReadPaths: [...new Set(hits.map((h) => h.path))].filter((p) => !access.denied(p)).sort().slice(0, MAX_READING_ORDER_LINES),
  };
}

/**
 * Fill `budget.renderedBytes`/`truncated` after a deterministic pre-render (§6). Rendering never reads the budget
 * fields, so the second pass is stable. The stored ImpactReport carries exactly this finalized summary (§5).
 */
export function finalizeSummaryBudget(summary: PrSummary): PrSummary {
  const rendered = renderSummarySection(summary, {});
  return {
    ...summary,
    budget: { renderedBytes: rendered.bytes, truncated: rendered.cuts.length > 0, omitted: summary.budget.omitted },
  };
}

// ---------------------------------------------------------------- honest-label gate (§7.6)

export type SummaryLineKind =
  | "COUNTS" | "HIGH_IMPACT" | "READING_ORDER" | "ALSO_READ" | "TESTS"
  | "DOCS_ONLY" | "DESCRIPTION_INTRO" | "DESCRIPTION_LIST" | "UNRESOLVED" | "CAVEAT" | "OMITTED" | "INCOMPLETE" | "GAP";

/** Template kinds allowed to carry structural behaviour wording (§7.2). */
const BEHAVIOUR_KINDS = new Set<SummaryLineKind>(["READING_ORDER", "TESTS"]);

export interface SummaryLine { kind: SummaryLineKind; text: string; /** Set for the author quote: §7.6 allows intent verbs only inside it. */ quoted?: boolean }
export interface SummaryGateCtx { counts?: PrSummary["counts"] }

const INTENT_RE = /\b(fix(es|ed)?|improve[sd]?|refactor(ed|s|ing)?|aims? to|intends? to|addresses|resolves?|closes?)\b/i;

/**
 * §7.6 — a summary line that fails this gate cannot be produced. Rejects: a sentence with no fact kind; intent verbs
 * attributed to CIE (the author's quoted description is exempt — it is labelled unverified, never CIE's voice); a
 * counts line that disagrees with the stored counts; any line over the per-line budget.
 */
export function checkSummaryLine(line: SummaryLine, ctx: SummaryGateCtx = {}): { ok: true } | { ok: false; rule: number; reason: string } {
  if (!line.kind) return { ok: false, rule: 1, reason: "a sentence with no fact kind cannot be rendered (§7.2)" };
  if (!line.quoted && INTENT_RE.test(line.text)) return { ok: false, rule: 2, reason: "intent wording is never attributed to CIE (§7.6, §12)" };
  if (line.kind === "COUNTS") {
    const expected = ctx.counts ? countsLine(ctx.counts) : null;
    if (expected && line.text !== expected) return { ok: false, rule: 3, reason: "counts line disagrees with the stored counts (§7.6)" };
  }
  if (Buffer.byteLength(line.text, "utf8") > MAX_LINE_BYTES) return { ok: false, rule: 4, reason: "line over the per-line budget" };
  return { ok: true };
}

/** The one canonical counts sentence (§1.2); checkSummaryLine regenerates it to detect a mutated count (F13-A1). */
export function countsLine(c: PrSummary["counts"]): string {
  const parts = [
    `${c.files} file${c.files === 1 ? "" : "s"}`,
    `${c.modules} module${c.modules === 1 ? "" : "s"}`,
    `${c.modified} symbol${c.modified === 1 ? "" : "s"} modified, ${c.added} added, ${c.deleted} deleted`,
  ];
  if (c.renamed) parts.push(`${c.renamed} relocated`);
  if (c.testFiles) parts.push(`${c.testFiles} test file${c.testFiles === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- renderer (§12, §13)

export interface RenderSummaryOpts {
  /** §9/F13-A9: an INCOMPLETE analysis states it first and omits the reading order. */
  incomplete?: boolean;
  incompleteReasons?: string[];
  /** compare() gaps surfaced beside the section (§14: a rename seen as delete+add is stated, not smoothed over). */
  gaps?: string[];
  reviewUrl?: string;
}
export interface RenderedSummary {
  markdown: string;
  bytes: number;
  cuts: string[];
  omittedPaths: number;
  lines: number;
}

const mdCode = (s: string) => `\`${escapeForgeText(s).replace(/`/g, "\\`")}\``;
const listOr = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * Render the summary section (its own `<!-- cie-summary -->` sub-marker inside the F11 comment, §5). Deterministic:
 * the same summary renders byte-identical Markdown (§11). Every line passes checkSummaryLine before it is emitted;
 * a failing line is omitted and counted, never emitted. The section stays under SUMMARY_BUDGET_BYTES; cut sections
 * are named (§13, F13-A10).
 */
export function renderSummarySection(summary: PrSummary, opts: RenderSummaryOpts = {}): RenderedSummary {
  const cuts: string[] = [];
  let omittedPaths = 0;
  const emit = (lines: SummaryLine[], line: SummaryLine): boolean => {
    const verdict = checkSummaryLine(line, { counts: summary.counts });
    if (verdict.ok) { lines.push(line); return true; }
    omittedPaths++;
    return false;
  };

  const out: SummaryLine[] = [];
  if (opts.incomplete) {
    emit(out, {
      kind: "INCOMPLETE",
      text: `**INCOMPLETE** — ${(opts.incompleteReasons?.length ? opts.incompleteReasons.join("; ") : "part of the analysis did not finish")}. What follows is partial; the reading order is a suggestion, not a proof.`,
    });
  }

  if (summary.docsOnly) {
    // §14/F13-A11: a docs-only PR gets a single line from the T0 rule.
    emit(out, { kind: "DOCS_ONLY", text: `Documentation only — ${countsLine(summary.counts)}; nothing executable changed.` });
  } else {
    emit(out, { kind: "COUNTS", text: countsLine(summary.counts) });
    if (summary.highImpact.length) {
      const areas = summary.highImpact.map((h) => `${h.area} (${h.files} file${h.files === 1 ? "" : "s"})`);
      emit(out, { kind: "HIGH_IMPACT", text: `Touches high-impact areas: ${listOr(areas)}${opts.reviewUrl ? ` ([why this label?](${opts.reviewUrl}))` : ""}.` });
    }

    if (summary.graphComplete === false) {
      emit(out, { kind: "OMITTED", text: "Reading order omitted: the call graph for this change did not finish; a wrong order is worse than none." });
    } else if (summary.readingOrder.length) {
      emit(out, { kind: "READING_ORDER", text: "### Start here (suggested reading order)" });
      for (const r of summary.readingOrder) {
        const names = r.entityIds.slice(0, 4).map((id) => mdCode(shortName(id)));
        emit(out, { kind: "READING_ORDER", text: `${r.rank}. ${mdCode(r.path)} — ${names.join(", ")} ${r.note}` });
      }
      if (summary.budget.omitted > 0) {
        emit(out, { kind: "OMITTED", text: `… ${summary.budget.omitted} more file(s) are on the review page${opts.reviewUrl ? ` (${opts.reviewUrl})` : ""}.` });
      }
      if (summary.alsoReadPaths?.length) {
        emit(out, { kind: "ALSO_READ", text: `Also read (high-impact): ${summary.alsoReadPaths.map(mdCode).join(", ")}.` });
      }
    }

    const t = summary.tests;
    if (t.added || t.removed || t.lostReach.length) {
      const bits: string[] = [];
      if (t.added) bits.push(`${t.added} test${t.added === 1 ? "" : "s"} added`);
      if (t.removed) bits.push(`${t.removed} test${t.removed === 1 ? "" : "s"} removed`);
      emit(out, { kind: "TESTS", text: `Tests: ${listOr(bits)}${t.lostReach.length ? `; ${t.lostReach.length} test${t.lostReach.length === 1 ? "" : "s"} no longer reach ${listOr(t.lostReach.slice(0, 3).map((l) => mdCode(l)))}${t.lostReach.length > 3 ? "…" : ""}` : ""}.` });
    }
  }

  // §7.5 — the description versus the change. The author text appears only inside a quoted block labelled
  // unverified (§7.6); it is escaped, so it cannot ping, link or forge a marker (F13-A5).
  if (summary.description) {
    const d = summary.description;
    emit(out, { kind: "DESCRIPTION_INTRO", text: "### The description versus the change" });
    const excerpt = d.authorText.length > AUTHOR_EXCERPT_CHARS ? `${d.authorText.slice(0, AUTHOR_EXCERPT_CHARS)}…` : d.authorText;
    emit(out, { kind: "DESCRIPTION_INTRO", quoted: true, text: `> Author's description (unverified): "${escapeForgeText(excerpt)}"` });
    if (d.changedNotMentioned.length) {
      const shown = d.changedNotMentioned.slice(0, MAX_LIST_LINES);
      emit(out, { kind: "DESCRIPTION_LIST", text: `- Changed but not mentioned in the description: ${shown.map((c) => mdCode(c.path)).join(", ")}${d.changedNotMentioned.length > MAX_LIST_LINES ? ` … ${d.changedNotMentioned.length - MAX_LIST_LINES} more` : ""}` });
    }
    if (d.mentionedNotChanged.length) {
      const shown = d.mentionedNotChanged.slice(0, MAX_LIST_LINES);
      emit(out, { kind: "DESCRIPTION_LIST", text: `- Mentioned but not changed: ${shown.map((m) => `"${escapeForgeText(m.phrase)}"`).join(", ")}${d.mentionedNotChanged.length > MAX_LIST_LINES ? ` … ${d.mentionedNotChanged.length - MAX_LIST_LINES} more` : ""}` });
    }
    if (d.unresolved.length) {
      const shown = d.unresolved.slice(0, MAX_LIST_LINES);
      emit(out, { kind: "UNRESOLVED", text: `- Could not be matched to the code (not claimed as missing): ${shown.map((u) => `"${escapeForgeText(u)}"`).join(", ")}${d.unresolved.length > MAX_LIST_LINES ? ` … ${d.unresolved.length - MAX_LIST_LINES} more` : ""}` });
    }
    emit(out, {
      kind: "CAVEAT",
      text: "This compares names in the description with names in the change. It does not understand meaning, and a short description can be accurate without naming everything.",
    });
  } else if (!summary.docsOnly) {
    emit(out, { kind: "DESCRIPTION_INTRO", text: "No description to compare." });
  }

  for (const g of (opts.gaps ?? []).slice(0, 3)) emit(out, { kind: "GAP", text: `Gap: ${escapeForgeText(g)}` });

  // §13 length budget: cut the description lists first, then reading-order detail — every cut is named.
  const bytesOf = (ls: SummaryLine[]) => Buffer.byteLength([SUMMARY_MARKER, ...ls.map((l) => l.text)].join("\n"), "utf8");
  if (bytesOf(out) > SUMMARY_BUDGET_BYTES) {
    let lines = out;
    const withoutLists = lines.filter((l) => !["DESCRIPTION_LIST", "UNRESOLVED"].includes(l.kind));
    if (withoutLists.length !== lines.length) { cuts.push("description lists trimmed"); lines = withoutLists; }
    const header = lines.filter((l) => l.kind === "READING_ORDER" && l.text.startsWith("###"));
    const entries = lines.filter((l) => l.kind === "READING_ORDER" && !l.text.startsWith("###"));
    if (bytesOf(lines) > SUMMARY_BUDGET_BYTES && entries.length > 6) {
      lines = [...lines.filter((l) => l.kind !== "READING_ORDER"), ...header, ...entries.slice(0, 6)];
      cuts.push("reading order trimmed to the first 6 files");
    }
    if (bytesOf(lines) > SUMMARY_BUDGET_BYTES) {
      cuts.push("section truncated");
      while (lines.length > 2 && bytesOf(lines) > SUMMARY_BUDGET_BYTES) lines.pop();
    }
    out.length = 0;
    out.push(...lines);
  }

  const markdown = [SUMMARY_MARKER, ...out.map((l) => l.text)].join("\n");
  return { markdown, bytes: Buffer.byteLength(markdown, "utf8"), cuts, omittedPaths, lines: out.length };
}
