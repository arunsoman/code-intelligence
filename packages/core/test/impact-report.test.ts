/**
 * F11 — impact report, honest-label gate and comment renderer (acceptance A2, A3, A5, A6, A7, A9, A10, A12, A13).
 * Pure unit tests over a synthetic ChangeSet: the builder is deterministic, the gate is pure, and the renderer is
 * byte-identical for a given report hash.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalyzerRecord, ImpactItem, ImpactReport } from "@cie/schema";
import type { ChangeSet, Consequence } from "../src/history.ts";
import {
  buildImpactReport, checkImpactLine, CONSEQUENCE_CLASS, DEFAULT_IMPACT_POLICY,
  explainImpactItem, impactReportHash, validateImpactPolicy, type ImpactBuildInput,
} from "../src/impact-report.ts";
import {
  checkCommentContract, CLOSING_LINE, escapeForgeText, HYPOTHESIS_CAVEAT, IMPACT_MARKER,
  renderImpactComment, renderImpactRetiredComment,
} from "../src/impact-render.ts";

const CHARGE = "function:src/payments/payment-service.ts#charge";
const REFUND = "function:src/payments/refunds.ts#computeRefund";

const consequence = (kind: Consequence["kind"], text: string, evidenceIds: string[] = ["ev:1"]): Consequence =>
  ({ id: "csq:" + kind, kind, text, evidenceIds, claimId: "clm:1", displayMode: "INFERENCE" });

const baseInput = (over: Partial<ImpactBuildInput> = {}): ImpactBuildInput => ({
  analysisId: "pna:test",
  baseHash: "b".repeat(40),
  headHash: "h".repeat(40),
  cs: {
    base: "rev-base", head: "rev-head",
    entities: [
      { canonId: "c1", base: CHARGE, head: CHARGE, change: "MODIFIED" },
      { canonId: "c2", base: REFUND, head: REFUND, change: "UNCHANGED" },
    ],
    textDiff: { filesChanged: 1, symbolsTouched: 1 },
    consequences: [
      consequence("TRANSACTION_BYPASS", `charge now reaches adjustBalance, which writes balance outside a transaction; before the change it did not reach it.`, ["ev:w1", "ev:w2"]),
    ],
    claims: [],
    blastRadius: [{ entityId: CHARGE, dependents: 4, files: ["src/api/payments-controller.ts", "src/queue/jobs.ts"] }],
    testImpact: [{ entityId: CHARGE, lost: ["payments.test › rolls back on failure"], gained: [], unchanged: [] }],
    gaps: [],
  },
  coverage: { source: "REPOSITORY", executableChangedLines: 3, covered: 0, percent: null, disclosure: "no test or coverage artifact was available for this head" },
  analyzers: [
    { id: "security-rules", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 41, skippedFiles: 0, reason: "scope" } },
    { id: "defect-detectors", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 41, skippedFiles: 0, reason: "scope" } },
    { id: "test-artifacts", version: "1", state: "COMPLETE", coverage: { analyzedFiles: 0, skippedFiles: 0, reason: "artifacts" } },
  ],
  unresolvedDynamicCalls: 0,
  incomplete: false,
  incompleteReasons: [],
  now: "2026-10-07T10:00:00.000Z",
  ...over,
});

const reportOf = (over: Parameters<typeof baseInput>[0] = {}) => buildImpactReport(baseInput(over));

// ---------------------------------------------------------------- F11-A10: the fixed class table, a test per kind

test("F11-A10: every consequence kind maps to its fixed claim class (FACT only for single directly-observed facts)", () => {
  const all: Consequence["kind"][] = ["CALL_ADDED", "CALL_REMOVED", "NEW_EXTERNAL_DEPENDENCY", "ERROR_PATH_ADDED", "TESTS_LOST", "MODULE_COUPLING", "TRANSACTION_BYPASS", "TRANSACTION_RESTORED", "WRITE_REACH_CHANGED", "NEW_CYCLE"];
  const cs: ChangeSet = {
    ...baseInput().cs,
    consequences: all.map((kind) => consequence(kind, `${kind} happened to ${kind.toLowerCase()}.`, ["ev:1"])),
  };
  // distinct subjects so the dedupe keeps them all
  cs.consequences.forEach((c, i) => { c.text = `${c.kind} text ${i}`; });
  cs.entities = all.map((_, i) => ({ canonId: `c${i}`, base: `function:src/f${i}.ts#fn${i}`, head: `function:src/f${i}.ts#fn${i}`, change: "MODIFIED" }));
  const byText = new Map(reportOf({ cs }).surfaced.concat(reportOf({ cs }).suppressed).map((i) => [i.text, i]));
  for (const kind of all) {
    const idx = all.indexOf(kind);
    const item = byText.get(`${kind} text ${idx}`)!;
    assert.ok(item, `an item exists for ${kind}`);
    assert.equal(item.claimClass, CONSEQUENCE_CLASS[kind], `${kind} → ${CONSEQUENCE_CLASS[kind]}`);
  }
  assert.equal(CONSEQUENCE_CLASS.TRANSACTION_BYPASS, "INFERENCE");
  assert.equal(CONSEQUENCE_CLASS.CALL_ADDED, "FACT");
});

// ---------------------------------------------------------------- §7.1 building the report

test("§7.1: consequences keep their evidence ids; test impact maps only when tests were lost; missing coverage is Fog, never a pass", () => {
  const cs = baseInput().cs;
  cs.consequences = [
    consequence("TRANSACTION_BYPASS", `charge now reaches adjustBalance, which writes balance outside a transaction; before the change it did not reach it.`, ["ev:w1", "ev:w2"]),
    consequence("CALL_ADDED", `charge now calls adjustBalance.`, ["ev:call"]),
  ];
  cs.testImpact = [
    { entityId: CHARGE, lost: ["payments.test › rolls back on failure"], gained: ["new.test › added"], unchanged: [] },
    { entityId: REFUND, lost: [], gained: ["refunds.test › new reach"], unchanged: [] },
  ];
  const r = reportOf({ cs });
  const bypass = r.surfaced.find((i) => i.text.includes("outside a transaction"))!;
  assert.deepEqual(bypass.evidenceIds, ["ev:w1", "ev:w2"]);
  assert.equal(bypass.claimClass, "INFERENCE");
  const lost = r.surfaced.find((i) => i.kind === "TEST_IMPACT")!;
  assert.equal(lost.claimClass, "FACT");
  assert.ok(!r.surfaced.some((i) => i.text.includes("refunds.test")), "gained-only test impact is not surfaced as a consequence");
  assert.ok(r.fog.some((f) => /No coverage evidence for 3 changed line/.test(f.text)), "missing coverage is Fog");
});

test("§7.1.5: fog assembles gaps, skipped files, unfinished analyzers and unresolved dynamic calls — counted, never silent", () => {
  const analyzers: AnalyzerRecord[] = [
    { id: "security-rules", version: "1", state: "TIMED_OUT", coverage: { analyzedFiles: 10, skippedFiles: 5, reason: "changed files and their dependents (depth 2)" }, reason: "timed out after 300 s" },
  ];
  const r = reportOf({
    cs: { ...baseInput().cs, gaps: ["No git history is available"] },
    analyzers, unresolvedDynamicCalls: 2,
  });
  const fogText = r.fog.map((f) => f.text).join("\n");
  assert.match(fogText, /No git history is available/);
  assert.match(fogText, /5 file\(s\) were not analysed by security-rules@1/);
  assert.match(fogText, /states TIMED_OUT/);
  assert.match(fogText, /2 dynamic call\(s\).*frameworks, proxies and configuration are invisible/);
});

test("§6.2: the report summary counts changed symbols, dependents and files from the blast radius", () => {
  const r = reportOf({});
  assert.equal(r.reach.changedSymbols, 1);
  assert.equal(r.reach.dependents, 4);
  assert.equal(r.reach.files, 2);
  assert.equal(r.coverage.evidenceComplete, true);
  assert.equal(r.schemaVersion, 1);
});

// ---------------------------------------------------------------- §7.2 ranking, §7.3 dedupe, §7.4 threshold

const rankedKinds = (): string[] => {
  const kinds: Consequence["kind"][] = ["CALL_REMOVED", "MODULE_COUPLING", "ERROR_PATH_ADDED", "NEW_CYCLE", "TESTS_LOST", "TRANSACTION_BYPASS"];
  const cs = baseInput().cs;
  cs.consequences = kinds.map((kind, i) => consequence(kind, `fn${i} ${kind.toLowerCase()} subject ${i}.`, ["ev:1"]));
  cs.entities = kinds.map((_, i) => ({ canonId: `c${i}`, base: `function:src/s${i}.ts#fn${i}`, head: `function:src/s${i}.ts#fn${i}`, change: "MODIFIED" }));
  cs.blastRadius = [];
  cs.testImpact = [];
  const r = reportOf({ cs });
  return r.surfaced.concat(r.suppressed).sort((a, b) => b.rank.score - a.rank.score).map((i) => i.text);
};

test("§7.2: kind severity dominates the ranking in the documented order", () => {
  const order = rankedKinds();
  const pos = (s: string) => order.findIndex((t) => t.includes(s));
  assert.ok(pos("transaction_bypass") < pos("tests_lost"));
  assert.ok(pos("tests_lost") < pos("new_cycle"));
  assert.ok(pos("new_cycle") < pos("error_path_added"));
  assert.ok(pos("error_path_added") < pos("module_coupling"));
  assert.ok(pos("module_coupling") < pos("call_removed"));
});

test("§7.2: a subject with no test at the head carries the test-gap factor; the history factor is visible at 0 until slice S4", () => {
  const cs = baseInput().cs;
  cs.consequences = [consequence("TRANSACTION_BYPASS", `charge now reaches adjustBalance, which writes balance outside a transaction; before the change it did not reach it.`, ["ev:1"])];
  const r = reportOf({ cs });
  const item = r.surfaced.find((i) => i.kind === "CONSEQUENCE")!;
  const testGap = item.rank.factors.find((f) => f.name === "test gap")!;
  assert.equal(testGap.value, 1, "charge lost its only reaching test");
  const history = item.rank.factors.find((f) => f.name === "history")!;
  assert.equal(history.value, 0);
  assert.equal(item.calibration, "uncalibrated");
});

test("§7.3: a lower-severity kind restating the same entity pair is suppressed DUPLICATE and kept for why-not", () => {
  const cs = baseInput().cs;
  // same subject (charge) for both: the module-coupling statement outranks the added-call statement
  cs.consequences = [
    consequence("MODULE_COUPLING", `charge now calls adjustBalance.`, ["ev:1"]),
    consequence("CALL_ADDED", `charge now calls adjustBalance, again stated.`, ["ev:2"]),
  ];
  const r = reportOf({ cs });
  const dup = r.suppressed.find((i) => i.text.includes("again stated"))!;
  assert.equal(dup.suppressed?.reason, "DUPLICATE");
  assert.ok(r.surfaced.some((i) => i.text === "charge now calls adjustBalance."));
  const why = explainImpactItem(r, dup.id);
  assert.equal(why.kind, "suppressed");
  assert.equal((why as { reason: string }).reason, "DUPLICATE");
});

test("§7.4: nothing at or above the threshold ⇒ nothing surfaced (silence is a designed outcome)", () => {
  const r = reportOf({ policy: { ...DEFAULT_IMPACT_POLICY, minScore: 1000 } });
  assert.equal(r.surfaced.length, 0);
  assert.ok(r.suppressed.length > 0);
  assert.ok(r.suppressed.every((i) => i.suppressed?.reason === "BELOW_THRESHOLD"));
});

test("§7.4: maxItems bounds the surfaced list; the rest is LENGTH_BUDGET suppressed and counted", () => {
  const cs = baseInput().cs;
  cs.consequences = [
    consequence("TRANSACTION_BYPASS", `charge now reaches adjustBalance, which writes balance outside a transaction; before the change it did not reach it.`, ["ev:1"]),
    consequence("NEW_CYCLE", `xfn now cycles back to itself.`, ["ev:2"]),
  ];
  cs.entities = [
    { canonId: "c1", base: CHARGE, head: CHARGE, change: "MODIFIED" },
    { canonId: "c2", base: "function:src/x.ts#xfn", head: "function:src/x.ts#xfn", change: "MODIFIED" },
  ];
  const r = reportOf({ cs, policy: { ...DEFAULT_IMPACT_POLICY, maxItems: 1 } });
  assert.equal(r.surfaced.length, 1);
  assert.ok(r.suppressed.some((i) => i.suppressed?.reason === "LENGTH_BUDGET"));
});

test("explainImpactItem: surfaced items expose factors with weights and calibration; unknown ids say not-found", () => {
  const r = reportOf({});
  const hit = r.surfaced[0] ?? r.suppressed[0];
  const exp = explainImpactItem(r, hit.id);
  assert.notEqual(exp.kind, "not-found");
  if (exp.kind !== "not-found") {
    assert.ok(exp.factors.length >= 4);
    assert.ok(exp.factors.every((f) => f.status === "uncalibrated"));
    assert.equal(typeof exp.factors[0].weight, "number");
  }
  assert.equal(explainImpactItem(r, "imp:missing").kind, "not-found");
});

// ---------------------------------------------------------------- §7.6 the honest-label gate (F11-A3/A5/A7)

const item = (over: Partial<ImpactItem> = {}): ImpactItem => ({
  id: "imp:t", kind: "CONSEQUENCE", claimClass: "INFERENCE",
  text: "charge now reaches adjustBalance, which writes balance outside a transaction.",
  subjectEntityIds: [CHARGE], evidenceIds: ["ev:1"], citations: [{ path: "src/payments/payment-service.ts", startLine: 10, endLine: 12 }],
  rank: { score: 30, factors: [] }, calibration: "uncalibrated", ...over,
});

test("F11-A3: a non-Fog line without a resolvable evidence id is rejected, and deleting the evidence row rejects the line", () => {
  assert.equal(checkImpactLine(item({ evidenceIds: [] })).ok, false);
  assert.equal(checkImpactLine(item()).ok, true);
  assert.equal(checkImpactLine(item(), { resolveEvidence: () => false }).ok, false);
  assert.equal(checkImpactLine(item(), { resolveEvidence: (id) => id === "ev:1" }).ok, true);
  // Fog lines carry no evidence by design
  assert.equal(checkImpactLine(item({ kind: "FOG", claimClass: "FOG", evidenceIds: [] })).ok, true);
});

test("F11-A5: presentation mutations are rejected — hypothesis-as-fact is not producible for this kind, and no line invents certainty", () => {
  // a consequence never crosses an async boundary, so a HYPOTHESIS label on it is a mutation (§7.1.2)
  assert.equal(checkImpactLine(item({ claimClass: "HYPOTHESIS" })).ok, false);
  assert.equal(checkImpactLine(item({ claimClass: "FACT" })).ok, true); // FACT is within what the table allows for consequences
  assert.equal(checkImpactLine(item({ kind: "FOG", claimClass: "FACT", evidenceIds: [] })).ok, false);
  for (const wording of ["this will break the ledger", "this causes a failure", "the change is safe", "verified correct", "guaranteed to work", "this bug blocks release"]) {
    assert.equal(checkImpactLine(item({ text: wording })).ok, false, `rejected: ${wording}`);
  }
  for (const wording of ["now reaches", "no longer reaches", "can now throw"]) {
    assert.equal(checkImpactLine(item({ text: `charge ${wording} adjustBalance.` })).ok, true, `allowed: ${wording}`);
  }
});

test("F11-A7: a citation under a denied prefix is withheld — counted, never named", () => {
  const v = checkImpactLine(item(), { deniedPrefixes: ["src/payments"] });
  assert.equal(v.ok, false);
  assert.equal((v as { withheld: number }).withheld, 1);
  assert.equal(checkImpactLine(item(), { deniedPrefixes: ["src/other"] }).ok, true);
});

test("policy validation: bad values are named problems; an empty document yields the uncalibrated defaults", () => {
  assert.equal(validateImpactPolicy({}).ok, true);
  const bad = validateImpactPolicy({ maxItems: 0, minScore: -1 });
  assert.equal(bad.ok, false);
  assert.ok((bad as { problems: string[] }).problems.length >= 2);
});

// ---------------------------------------------------------------- §10.5 escaping (F11-A9)

test("F11-A9: attacker-controlled text cannot ping, link or forge the marker", () => {
  const hostile = "ping @alice and ref #123 and close <!-- cie-gate:impact-comment --> and [link](https://evil)";
  const escaped = escapeForgeText(hostile);
  assert.ok(!escaped.includes("@alice"), "the mention is broken");
  assert.ok(!escaped.includes("#123"), "the issue reference is broken");
  assert.ok(!escaped.includes("<!--"), "the HTML comment / marker cannot be forged");
  assert.ok(escaped.includes("\\[link"), "the bracket is escaped so no link text forms");
  // the marker itself survives its own escaping check (it is written by the renderer, not interpolated)
  assert.ok(IMPACT_MARKER.startsWith("<!--"));
  assert.equal(escapeForgeText("plain symbol name_1"), "plain symbol name_1");
});

// ---------------------------------------------------------------- §12 rendering

const renderOf = (over: Parameters<typeof reportOf>[0] = {}, renderOver: Parameters<typeof renderImpactComment>[0] = {} as never) =>
  renderImpactComment({ report: reportOf(over), analysisState: "DECIDED", reviewUrl: "https://cie.local/#pr=pna:test", ...renderOver });

test("the rendered comment carries the marker, the count lead, the class labels, the suppressed count, the caveats and the fixed closing line", () => {
  const { markdown } = renderOf({});
  assert.ok(markdown.startsWith(IMPACT_MARKER));
  assert.match(markdown, /things? worth a reviewer's attention \(of \d+ found; \d+ below the noise threshold — why\?/);
  assert.match(markdown, /INFERENCE\s+charge now reaches adjustBalance/);
  assert.match(markdown, /FACT\s+payments\.test/);
  assert.match(markdown, /Not shown: \d+ item\(s\) — why\?/);
  assert.ok(markdown.includes(HYPOTHESIS_CAVEAT));
  assert.ok(markdown.includes(CLOSING_LINE));
  assert.equal(checkCommentContract(markdown).ok, true);
});

test("F11-A13: the dry run is byte-identical to what the publisher posts for the same report hash", () => {
  const a = renderOf({});
  const b = renderOf({});
  assert.equal(a.markdown, b.markdown);
  assert.equal(impactReportHash(reportOf({})), impactReportHash(reportOf({})));
});

test("F11-A2: an INCOMPLETE analysis states the incompleteness first, never as a footnote", () => {
  const analyzers: AnalyzerRecord[] = [{ id: "security-rules", version: "1", state: "TIMED_OUT", coverage: { analyzedFiles: 1, skippedFiles: 9, reason: "scope" }, reason: "timed out after 300 s" }];
  const { markdown } = renderOf({ analyzers });
  const incompleteAt = markdown.indexOf("INCOMPLETE");
  const firstItemAt = markdown.search(/\d\. (FACT|INFERENCE|HYPOTHESIS|FOG)/);
  assert.ok(incompleteAt > 0 && (firstItemAt === -1 || incompleteAt < firstItemAt), "INCOMPLETE comes before any item line");
  assert.match(markdown, /[Aa]nalyzer security-rules@\u200b?1 states TIMED_OUT/);
});

test("F11-A12: budget exhaustion names the sections cut — never a silent partial report", () => {
  const cs = baseInput().cs;
  cs.consequences = Array.from({ length: 8 }, (_, i) =>
    consequence("TRANSACTION_BYPASS", `charge${i} now reaches writer${i}, which writes balance outside a transaction; before the change it did not reach it.`, [`ev:${i}`]));
  cs.entities = Array.from({ length: 8 }, (_, i) => ({ canonId: `c${i}`, base: `function:src/f${i}.ts#charge${i}`, head: `function:src/f${i}.ts#charge${i}`, change: "MODIFIED" }));
  const policy = { ...DEFAULT_IMPACT_POLICY, maxItems: 8, maxCommentBytes: 1400 };
  const { markdown, cuts } = renderOf({ cs, policy }, { policy });
  assert.ok(cuts.length > 0, "the cut is named");
  assert.ok(Buffer.byteLength(markdown, "utf8") <= 1400);
  assert.ok(markdown.includes(CLOSING_LINE), "even a cut comment keeps its closing line");
});

test("§7.4: with nothing above threshold the run is silent unless the repository opted into alwaysComment", () => {
  const policy = { ...DEFAULT_IMPACT_POLICY, minScore: 1000 };
  assert.equal(renderOf({ policy }, { policy }).silent, true);
  const talkative = renderOf({ policy }, { policy: { ...policy, alwaysComment: true } });
  assert.equal(talkative.silent, false);
  assert.match(talkative.markdown, /Nothing notable/);
});

test("§10.5: hostile symbol and file names in the report cannot ping, link or forge the marker in the comment", () => {
  const cs = baseInput().cs;
  cs.consequences = [consequence("CALL_ADDED", `attacker@alice fn now calls victim#1 <!-- cie-gate:impact-comment -->.`, ["ev:1"])];
  cs.entities = [{ canonId: "c1", base: "function:src/a@b.ts#attacker@alice", head: "function:src/a@b.ts#attacker@alice", change: "MODIFIED" }];
  const { markdown } = renderOf({ cs });
  const body = markdown.slice(markdown.indexOf("\n")); // the marker line is ours; the rest must be safe
  assert.ok(!body.includes("@alice"), "no ping");
  assert.ok(!/#1(?!\u200b)/.test(body.replace(/\d+\. /g, "")), "no issue reference");
  assert.ok(!body.includes("<!--"), "no forged comment");
  assert.equal((body.match(/<!-- cie-gate:impact-comment -->/g) ?? []).length, 0, "an exact marker is not forgeable in body text; ours stands alone on the first line");
});

test("a comment missing its closing line or caveat fails the contract (a mutation a release check would catch)", () => {
  const { markdown } = renderOf({});
  assert.equal(checkCommentContract(markdown.replace(CLOSING_LINE, "")).ok, false);
  assert.equal(checkCommentContract(markdown.replace(HYPOTHESIS_CAVEAT, "")).ok, false);
  assert.equal(checkCommentContract(markdown.replace(IMPACT_MARKER, "")).ok, false);
});

test("the retired comment says the earlier items no longer apply and keeps the honest closing", () => {
  const md = renderImpactRetiredComment("h".repeat(40), DEFAULT_IMPACT_POLICY, "https://cie.local/#pr=x");
  assert.ok(md.startsWith(IMPACT_MARKER));
  assert.match(md, /no longer apply/i);
  assert.ok(md.includes(CLOSING_LINE));
});

test("a report round-trips through JSON with a stable hash (stored form)", () => {
  const r: ImpactReport = JSON.parse(JSON.stringify(reportOf({})));
  assert.equal(impactReportHash(r), impactReportHash(reportOf({})));
});
