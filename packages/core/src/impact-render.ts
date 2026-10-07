// F11 — the impact comment renderer (§12) and the egress escaping rules (§10).
//
// Every line the renderer emits has already passed checkImpactLine (§7.6); this module cannot produce a line that
// fails it, because it runs each item through the gate before interpolating. All interpolated text — symbol names,
// paths, evidence excerpts — is attacker-controlled (a pull request can name a file `@user #1 <!--`), so it is
// escaped for Markdown and for GitHub mention syntax before it leaves (F11-A9). The comment ends with the fixed
// closing line; copy rules (§12.2) live here as code.
import type { ImpactItem, ImpactReport } from "@cie/schema";
import { checkImpactLine, type ImpactPolicy, DEFAULT_IMPACT_POLICY } from "./impact-report.ts";
import { renderSummarySection, SUMMARY_MARKER } from "./pr-summary.ts";
import { mutedCountLines, FEEDBACK_MARKER } from "./feedback.ts";

/** The impact comment updates independently of the F02 gate comment (decision D2). */
export const IMPACT_MARKER = "<!-- cie-gate:impact-comment -->";
/** The fixed closing line; present in every non-silent comment (§12.2). */
export const CLOSING_LINE = "Not a safety verdict. No finding is not *safe*.";
/** A hypothesis states what static analysis cannot see (§12.2). */
export const HYPOTHESIS_CAVEAT = "Hypotheses state what static analysis cannot see: frameworks, proxies and configuration are invisible to static analysis.";

// ---------------------------------------------------------------- escaping (§10.5, F11-A9)

/** Neutralise GitHub mention/reference syntax and HTML-comment forgeries in attacker-controlled text. */
export function escapeForgeText(s: string): string {
  return s
    .replace(/@/g, "@\u200b") // a mention only parses without the zero-width break
    .replace(/#(\d+)/g, "#\u200b$1") // issue references
    .replace(/<!--/g, "<\u200b!--") // cannot forge (or close) an HTML comment / marker
    .replace(/\[/g, "\\["); // no accidental link text from attacker-controlled brackets
}

/** Escape one interpolated inline fragment for Markdown: code-words are wrapped in backticks after escaping. */
const md = (s: string) => `\`${escapeForgeText(s).replace(/`/g, "\\`")}\``;

const fmtClass = (c: string) => (c === "FACT" ? "FACT" : c === "INFERENCE" ? "INFERENCE" : c === "HYPOTHESIS" ? "HYPOTHESIS" : "FOG");

// ---------------------------------------------------------------- contract check on the whole comment

/**
 * Rule 5 of §7.6, applied to the assembled comment: the caveat sections and the fixed closing line are present, and
 * the suppressed count is always shown so silence is never mistaken for thoroughness (§12.2).
 */
export function checkCommentContract(markdown: string): { ok: true } | { ok: false; reason: string } {
  if (!markdown.startsWith(IMPACT_MARKER)) return { ok: false, reason: "the comment must carry the impact marker first" };
  for (const needle of [CLOSING_LINE, "why?", HYPOTHESIS_CAVEAT]) {
    if (!markdown.includes(needle)) return { ok: false, reason: `a section lacks its caveat line: ${needle.slice(0, 40)}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- rendering

export interface RenderInput {
  report: ImpactReport;
  /** PR analysis state; INCOMPLETE is stated first, never footnoted (§9, F11-A2). */
  analysisState: string;
  incompleteReasons?: string[];
  policy?: ImpactPolicy;
  /** Denied path prefixes (counted, never named). */
  deniedPrefixes?: string[];
  /** Resolve evidence ids for the per-line gate. */
  resolveEvidence?: (evidenceId: string) => boolean;
  /** Link target for the in-app share page ("why not?"). */
  reviewUrl?: string;
  /** Repository display name, escaped before call. */
  repoLabel?: string;
}

export interface RenderedComment {
  markdown: string;
  /** True when nothing met the threshold and the policy stays silent (§7.4). */
  silent: boolean;
  /** Sections cut by the length budget, named (§13, F11-A12). */
  cuts: string[];
  withheldPaths: number;
}

/**
 * Render the impact comment. Deterministic: the same report hash renders byte-identical Markdown (F11-A13), so the
 * dry run prints exactly what the publisher posts.
 */
export function renderImpactComment(input: RenderInput): RenderedComment {
  const { report } = input;
  const policy = input.policy ?? DEFAULT_IMPACT_POLICY;
  const denied = input.deniedPrefixes ?? [];
  const cuts: string[] = [];
  let withheldPaths = 0;

  // Gate every line before it can be emitted (§7.6); a line that fails is replaced by a counted, unnamed note.
  const lineFor = (item: ImpactItem): string | null => {
    const verdict = checkImpactLine(item, { resolveEvidence: input.resolveEvidence, deniedPrefixes: denied });
    if (verdict.ok) {
      const cite = item.citations.length ? ` — ${item.citations.map((c) => `${md(c.path)}:${c.startLine}`).join(", ")}` : "";
      return `${fmtClass(item.claimClass)}  ${escapeForgeText(item.text)}${cite} · [evidence ▸](${input.reviewUrl ?? "#"})`;
    }
    if (verdict.rule === 4) { withheldPaths += verdict.withheld; return null; } // counted by the caller, never named
    return null; // a line that fails the gate cannot be produced (§1.3.3)
  };

  const found = report.surfaced.length + report.suppressed.length;
  // §9/F11-A2: an analysis any part of which did not finish is published with the incompleteness stated first,
  // never as a complete report with a footnote.
  const incomplete = input.analysisState === "INCOMPLETE" || !report.coverage.evidenceComplete;
  const incompleteReasons = input.incompleteReasons?.length
    ? input.incompleteReasons
    : report.fog.filter((f) => f.text.startsWith("Analyzer")).map((f) => f.text.replace(/\.$/, ""));
  /** Compose the comment for a given surfaced set — the length budget re-composes with fewer items, never mutates. */
  const compose = (surfaced: ImpactItem[]): string => {
    const out: string[] = [];
    // A surfaced item whose line fails the gate joins the not-shown bucket, counted with its reason — the comment
    // never claims attention it cannot show (F11-A3: a line that fails the gate cannot be produced).
    const renderedLines = surfaced.map((item) => ({ item, line: lineFor(item) }));
    const shown = renderedLines.filter((r) => r.line);
    const notShown = report.suppressed.length + (report.surfaced.length - surfaced.length) + (renderedLines.length - shown.length);
    out.push(IMPACT_MARKER);
    const head = report.headHash.slice(0, 7);
    const analysedAgo = Math.max(0, Math.round((Date.now() - Date.parse(report.generatedAt)) / 60_000));
    const fileNote = report.coverage.languages.map((l) => `${l.id} ${l.analysedFiles}/${l.analysedFiles + l.skippedFiles} files`).join(" · ");
    out.push(`## CIE blast radius — head ${md(head)}${input.repoLabel ? ` · ${input.repoLabel}` : ""}   analysed ${analysedAgo} min ago${fileNote ? ` · ${escapeForgeText(fileNote)}` : ""}`);

    if (incomplete) {
      out.push("", `**INCOMPLETE** — ${incompleteReasons.map(escapeForgeText).join("; ") || "part of the analysis did not finish"}. What follows is partial and says so on every line that needs it.`);
    }

    // F13: the deterministic summary/walkthrough is the first section of the comment (§12), inside the same
    // marker and budget; the same report hash renders byte-identical Markdown including this section.
    if (report.summary) {
      const section = renderSummarySection(report.summary, { incomplete, incompleteReasons, reviewUrl: input.reviewUrl });
      if (section.markdown.trim().length > SUMMARY_MARKER.length) out.push("", section.markdown);
    }

    if (surfaced.length) {
      out.push("", `${shown.length} thing${shown.length === 1 ? "" : "s"} worth a reviewer's attention (of ${found} found; ${notShown} below the noise threshold — why?${input.reviewUrl ? ` → ${input.reviewUrl}` : ""})`, "");
      shown.forEach((r, i) => out.push(`${i + 1}. ${r.line}`));
    } else if (policy.alwaysComment) {
      out.push("", `Nothing notable: ${found} item${found === 1 ? "" : "s"} below the noise threshold — why?${input.reviewUrl ? ` → ${input.reviewUrl}` : ""}`);
    }

    // Reach (§1.2): dependents per changed symbol, files, hotspots/thin ownership once slice S4 lands.
    const r = report.reach;
    const reachBits = [
      `${r.changedSymbols} changed symbol${r.changedSymbols === 1 ? "" : "s"} → ${r.dependents} dependent${r.dependents === 1 ? "" : "s"} in ${r.files} file${r.files === 1 ? "" : "s"}`,
      r.hotspotFiles ? `${r.hotspotFiles} change-risk hotspot file(s)` : null,
      r.thinOwnershipFiles ? `${r.thinOwnershipFiles} file(s) with a single recent author` : null,
    ].filter(Boolean).join(" · ");
    if (reachBits) out.push("", `Reach: ${escapeForgeText(reachBits)}`);

    // Fog (§1.2): what CIE could not determine — dynamic calls, skipped files, unfinished evidence.
    if (report.fog.length) {
      out.push("", `Not determined (Fog): ${report.fog.length} limitation${report.fog.length === 1 ? "" : "s"}`);
      for (const f of report.fog.slice(0, 5)) out.push(`- FOG  ${escapeForgeText(f.text)}`);
      if (report.fog.length > 5) out.push(`- FOG  … ${report.fog.length - 5} more on the review page`);
    }

    // The hypothesis caveat (§12.2) is fixed text and always present, like the closing line.
    out.push("", HYPOTHESIS_CAVEAT);
    if (withheldPaths) out.push(`${withheldPaths} citation(s) withheld: they name code the commenting principal may not read; they are counted, never named (why?${input.reviewUrl ? ` → ${input.reviewUrl}` : ""}).`);

    // F15: the feedback footer states the ranking status and the muted counts as stored (§7.6); muted items are
    // counted — silence is never confused with absence. Old reports (pre-F15) carry no feedback block.
    if (report.feedback) {
      const fb: string[] = [FEEDBACK_MARKER, report.feedback.line];
      for (const line of mutedCountLines(report.muted ?? [])) fb.push(line);
      out.push("", fb.join("\n"));
    }

    // Suppressed count is always shown (§12.2) — silence is never mistaken for thoroughness.
    out.push("", `Not shown: ${notShown} item(s) — why? each with its reason on the review page (why not?${input.reviewUrl ? ` → ${input.reviewUrl}` : ""}).`);
    out.push("", CLOSING_LINE);
    return out.join("\n");
  };

  // §13: hard length budget; overflow moves items to the share page and every cut is named (F11-A12).
  let shown = [...report.surfaced];
  let markdown = compose(shown);
  while (shown.length > 1 && Buffer.byteLength(markdown, "utf8") > policy.maxCommentBytes) {
    const dropped = shown.pop()!;
    cuts.push(`item ${shown.length + 1} (score ${dropped.rank.score}) moved to the review page`);
    markdown = compose(shown);
  }
  if (Buffer.byteLength(markdown, "utf8") > policy.maxCommentBytes) {
    cuts.push("detail lines truncated");
    markdown = markdown.slice(0, policy.maxCommentBytes - 200) + "\n\n…(truncated; the full report is on the review page)";
    if (!checkCommentContract(markdown).ok) markdown = markdown.slice(0, policy.maxCommentBytes - 400) + "\n\n" + CLOSING_LINE;
  }

  const contract = checkCommentContract(markdown);
  if (!contract.ok) throw new Error(`impact comment violates its own contract: ${contract.reason}`);
  const silent = !report.surfaced.length && !policy.alwaysComment && !incomplete;
  return { markdown, silent, cuts, withheldPaths };
}

/** The minimal update posted when earlier items no longer apply (§7.4, F11-A6). */
export function renderImpactRetiredComment(headHash: string, policy: ImpactPolicy, reviewUrl?: string): string {
  void policy;
  const out = [
    IMPACT_MARKER,
    `## CIE blast radius — head ${md(headHash.slice(0, 7))}`,
    "",
    "Nothing notable at this head: the items the earlier comment listed no longer apply. "
      + `Not shown: 0 item(s) (why not?${reviewUrl ? ` → ${reviewUrl}` : ""}).`,
    "",
    CLOSING_LINE,
  ];
  return out.join("\n");
}
