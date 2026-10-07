import re, json
spec = open('Prompt-to-feature.md').read()
rows = {}
for m in re.finditer(r'^\| (PF-\d{3}) \| (.+?) \| (C\d\d(?: / C\d\d)*) \|(?: ([^|]*) \|)?', spec, re.M):
    rows[m.group(1)] = dict(requirement=m.group(2), owner=m.group(3), supporting=(m.group(4) or '').strip())
assert len(rows) == 80, len(rows)

T = 'packages/core/src/execution.ts'
TT = ['packages/core/test/task-flow.test.ts', 'packages/core/test/task-pure.test.ts']
def r(status, actual, cls, gap, tests=(), iso=''):
    return dict(status=status, actual=actual, classification=cls, gap=gap, tests=list(tests), isolation=iso)
GAP='AUDITED_GAP'; PRES='AUDITED_PRESENT'
LP = 'LOCAL_PERMISSION_MODEL: node --permission, scrubbed env, wall-clock kill; no CPU/memory/pid limit, no kernel boundary (execution.ts header)'
A = {
 1: r(GAP, f'{T} Tasks.submitTask; TaskSpecSchema.kind is the literal FIX_DEFECT', 'extend', 'No prompt/brief/PRD/artifact intake and no BUILD_FEATURE kind', TT),
 2: r(GAP, f'{T} TaskSpec.repositoryId/baseRef', 'extend', 'No outcome mode (PLAN/BUILD_PREVIEW/CREATE_DRAFT_PR); no workspace-based target resolution'),
 3: r(GAP, 'packages/core/src/artifacts.ts (content-addressed), journal.ts, events.ts', 'extend', 'No SourceRef/protected prompt reference; sha256 helpers are ad hoc'),
 4: r(GAP, 'packages/core/src/retrieval.ts, indexer.ts, hotspots.ts', 'extend', 'No discovery coverage record or repository assessment', ['packages/core/test/retrieval.test.ts']),
 5: r(GAP, 'none', 'new', 'No requirement normalisation'), 6: r(GAP, f'{T} Tasks.draftPlan produces a plan, not a feature contract', 'new', 'No versioned feature contract'),
 7: r(GAP, 'none', 'new', 'No assumption/approved-obligation separation'),
 8: r(GAP, f'{T} task_obligations + resolveObligation (investigation obligations)', 'extend', 'No business-question planning or batching', TT),
 9: r(GAP, 'packages/core/src/jobs.ts', 'extend', 'One job at a time; no dependency-aware ready/blocked work'),
 10: r(GAP, 'packages/core/src/security.ts, claims.ts (analysis of code, not requirements)', 'new', 'No requirement conflict detection'),
 11: r(GAP, 'none', 'new', 'No finding classification'), 12: r(GAP, 'packages/core/src/tenants.ts, policy.ts, access.ts (path denial, egress)', 'extend', 'No scoped authority bindings or decision roles'),
 13: r(GAP, 'none', 'new', 'No witness/resolution options'), 14: r(GAP, f'{T} approveCandidate (expectedVersion, second approver)', 'extend', 'Approval only, no decision records with authority', TT),
 15: r(GAP, 'none', 'new', 'No completeness/testability checks'),
 16: r(GAP, 'packages/core/src/security.ts detects gates in analysed code', 'new', 'Nothing enforces access in generated code; proven only by acceptance tests of the built feature'),
 17: r(GAP, 'packages/core/src/tenants.ts', 'new', 'Same as PF-016 for tenancy/background/download policy'),
 18: r(GAP, f'{T} constraints.allowedPaths/maxFilesChanged', 'extend', 'No scope/prerequisite/follow-up classification'),
 19: r(GAP, f'{T} generation + STALE task state', 'extend', 'Task-level staleness only; no contract-version impact closure'),
 20: r(PRES, f'{T} EditOperation (REPLACE_SPAN/CREATE_FILE/DELETE_FILE), admissionProblems, scratch tree, PatchBinding (packages/schema/src/task.ts)', 'extend', 'FIX_DEFECT only; protected-path rule blocks test/CI/lockfile edits unless allowTestEdits; allowNewDependencies is literal false', TT, LP),
 21: r(PRES, f'{T} detectOracleWeakening, reviewPropertyChange, originalOracleHash/candidateOracleHash', 'extend', 'Assertion-diff heuristics only (spec accepts that)', TT),
 22: r(GAP, 'packages/core/src/migrations.ts (CIE\'s own schema)', 'new', 'Nothing for a target app\'s migrations'),
 23: r(GAP, 'packages/core/src/connectors.ts', 'new', 'No integration contract binding or mock labelling'),
 24: r(GAP, f'{T} validatePatch roles BASELINE/ORACLE_ORIGINAL_ON_CANDIDATE/CANDIDATE_SUITE/STATIC_CHECK/ORACLE_PRESERVATION', 'extend', 'Roles, not per-criterion validation', TT, LP),
 25: r(GAP, 'apps/web/test/e2e/harness.ts, cdp.ts (drives CIE\'s own UI)', 'extend', 'No browser validation of a target application'),
 26: r(PRES, f'{T} OracleRunResult.outcomes PASS/FAIL/SKIP/TODO/FLAKY; omissions disclosed', 'extend', 'Population check for benchmarks is separate (PF-029)', TT),
 27: r(GAP, 'packages/core/src/defect-performance.ts, profiling.ts', 'extend', 'No budget discovery or workload capture for features'),
 28: r(GAP, 'packages/core/src/defect-performance.ts (static detectors)', 'extend', 'Detectors target defects, not changed feature code'),
 29: r(GAP, 'packages/core/src/defect-benchmark.ts, twin-experiment.ts', 'extend', 'No paired baseline/candidate harness with equivalence and population checks', ['packages/core/test/defect-perf.test.ts']),
 30: r(GAP, 'none', 'new', 'No interference measurement'), 31: r(GAP, 'twin-validation.ts (model certificates)', 'new', 'No INCONCLUSIVE/UNVALIDATED performance states for features'),
 32: r(GAP, 'packages/core/src/jobs.ts, packages/model/src/budget.ts', 'extend', 'No runner caps or builder contention control'),
 33: r(GAP, 'apps/web/src/TaskPanel.tsx', 'extend', 'No role-aware preview'),
 34: r(PRES, f'{T} VerdictState/OracleState; apps/web/src/TaskPanel.tsx copy rules (§12.2)', 'extend', 'Single verdict axis; no implementation-vs-validation per criterion', TT),
 35: r(PRES, f'{T} createGrant/pushCandidate/publishDraftPR bound to bindingHash', 'extend', 'Binds task candidate, not contract+evidence set', TT),
 36: r(PRES, 'packages/core/src/gh-forge.ts (draft-only, cannot merge)', 'reuse', 'No deploy gating (deployment is out of slice)', ['packages/core/test/gh.test.ts']),
 37: r(PRES, 'packages/core/src/gh-forge.ts find-before-create; failpoint.ts', 'reuse', 'Idempotency proven for PR creation only', ['packages/core/test/gh.test.ts']),
 38: r(GAP, 'packages/core/src/jobs.ts cancel with commit point; Tasks.cancelTask', 'extend', 'No fencing tokens for late results', ['packages/core/test/jobs.test.ts']),
 39: r(GAP, 'events.ts, task_events (seq, idempotency key)', 'extend', 'No requirement→task→edit→test→evidence lineage index'),
 40: r(GAP, 'none verified', 'new', 'No test that retrieved text cannot widen tool authority'),
 41: r('IMPLEMENTED_UNVALIDATED', 'packages/core/src/feature/types.ts, migrations.ts v33, docs/prompt-to-feature/readiness.json', 'new', 'Five families and the register exist; enforcement and the "no framework prerequisite" check arrive with Wave 1 and task 4.2', ['packages/core/test/feature-scaffold.test.ts']),
 42: r('IMPLEMENTED_UNVALIDATED', 'packages/core/src/feature/canon.ts; crates/worker/src/canon.rs; fixtures/canon/canon-vectors.json', 'new', 'Vectors pass in Node and Rust. Digests come from an independent Python run, but the canonical strings were written by the implementer and have not had human review; not VALIDATED until they do', ['packages/core/test/feature-canon.test.ts', 'crates/worker canon::tests', 'scripts/canon-parity.mjs']),
 43: r(GAP, 'packages/core/src/feature/types.ts (CoverageRecord type only)', 'new', 'No discovery coverage producer or UI'),
 44: r(GAP, 'none', 'new', 'No pf-perf-core-v1'), 45: r(GAP, 'packages/core/src/policy.ts detectSecret', 'extend', 'No SAST/secret gate on candidates'),
 46: r(GAP, 'packages/core/src/deps/ (inventory, purl, versions)', 'extend', 'No dependency-diff gate, advisories or licence policy'),
 47: r(GAP, 'none', 'new', 'No generated-content provenance'), 48: r(GAP, 'none', 'new', 'No operational applicability'), 49: r(GAP, 'none', 'new', 'No release plan'),
 50: r(GAP, 'none', 'new', 'Schema only in slice 1'), 51: r(GAP, 'none', 'new', 'No review feedback ingestion'),
 52: r(GAP, 'packages/core/src/llm-router.ts (intent routing only), packages/model', 'extend', 'No ModelInvocation provenance record'),
 53: r(GAP, 'packages/core/src/policy.ts LOCAL_ONLY_PREDICATES; C03/setEgress', 'extend', 'No provider-fallback egress rule'),
 54: r(GAP, 'packages/core/src/gh.ts, gh-forge.ts (PR only)', 'extend', 'No issue creation or binding'), 55: r(GAP, f'{T} PatchBinding.changes (file kind + counts)', 'extend', 'No attribution to prompt/requirement/action'),
 56: r(GAP, 'packages/core/src/redact.ts (view redaction)', 'extend', 'No issue projection or sync'),
 57: r(GAP, 'retrieval.ts, graph.ts', 'new', 'No capability comparison'), 58: r(GAP, 'none', 'new', 'No overlap verification'), 59: r(GAP, 'none', 'new', 'No strategy selection'),
 60: r(GAP, 'none', 'new', 'No reuse regression obligations'), 61: r(GAP, 'none', 'new', 'No overlap report'), 62: r(GAP, 'none', 'new', 'No availability states'),
 63: r(GAP, 'jobs.ts', 'new', 'No mutation leases or relations'), 64: r(GAP, 'none', 'new', 'No UX/a11y/doc assessment of generated UI'), 65: r(GAP, 'none', 'new', 'No retirement governance'),
 66: r(GAP, 'none', 'new', 'No applicability/waiver model'), 67: r(GAP, 'none', 'new', 'No baseline-health classification for feature runs'),
 68: r(GAP, 'packages/core/src/isolated-exec.ts (symlink refusal, no shell, permission model)', 'extend', 'No command allowlist/network policy object; no unknown-outcome reconciliation beyond forge', ['packages/core/test/task-pure.test.ts'], LP),
 69: r(GAP, 'apps/web/src/build/BuildFeature.tsx (scaffold)', 'new', 'Stages not built; app uses modal panels, not tabs, so "tab" is a header button + panel'),
 70: r(GAP, 'none', 'new', 'No stale-impact feedback on backward edits'), 71: r(GAP, 'apps/web/src/arrange.ts, Canvas.tsx', 'extend', 'No change graph'),
 72: r(GAP, 'packages/core/src/changes.ts unifiedDiff', 'extend', 'No candidate file viewer'), 73: r(GAP, 'none', 'new', 'No test associations'),
 74: r(GAP, 'apps/web/src/TaskPanel.tsx role rows', 'extend', 'No baseline-vs-candidate dashboard'), 75: r(GAP, 'detectOracleWeakening', 'extend', 'No UI for assertion changes'),
 76: r(GAP, 'none', 'new', 'No diagnostics/repair UX'), 77: r(GAP, 'packages/core/src/exports.ts, changes.ts patchHash', 'extend', 'No manifest bundle or eligibility states'),
 78: r(GAP, 'none', 'new', 'No destination check/apply'), 79: r(GAP, 'apps/web/src/loading.ts, Skeleton.tsx', 'extend', 'No bounded log/graph artifacts'), 80: r(GAP, 'none', 'new', 'No wizard milestones in issue lineage'),
}
out=[]
for pid in sorted(rows):
    n=int(pid[3:]); a=A[n]
    out.append(dict(id=pid, **rows[pid], status=a['status'], actual=a['actual'], classification=a['classification'], gap=a['gap'], tests=a['tests'], isolation=a['isolation'] or 'n/a'))
doc=dict(schemaVersion=1, generatedFrom='Prompt-to-feature.md v1.3', auditedAt='2026-10-05', repoCommit='cf06dc0',
 statusLegend=['UNASSESSED','REPORTED_PARTIAL','AUDITED_PRESENT','AUDITED_GAP','IMPLEMENTED_UNVALIDATED','VALIDATED'],
 baseline=dict(command='npm test', result='pass', node=dict(unit=785, e2e=16), rust=dict(passed=47), note='run on cf06dc0 before any change; log not committed'),
 notes=['AUDITED_PRESENT means the substrate exists for the F07 FIX_DEFECT task flow, not that the feature path works.','No row is VALIDATED.'],
 rows=out)
json.dump(doc, open('docs/prompt-to-feature/readiness.json','w'), indent=1); open('docs/prompt-to-feature/readiness.json','a').write('\n')
from collections import Counter
print(Counter(x['status'] for x in out), Counter(x['classification'] for x in out))
