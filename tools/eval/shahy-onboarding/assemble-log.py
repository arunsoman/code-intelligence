#!/usr/bin/env python3
"""Assemble the answerable-today Q&A log: best result per question across runs (r1-r5),
each with CIE's answer, validation, latency, the tool-call trace from the wire log, and a
correctness note against the golden reference answer."""
import json, re, glob, pathlib, datetime, collections

RUNS = {}  # qid -> list of {run, file}
for f in sorted(glob.glob("/tmp/qrun/q*.json")) + sorted(glob.glob("/tmp/qrun/q*-r*.json")):
    m = re.match(r"q(\d+)(?:-r(\w+))?\.json$", pathlib.Path(f).name)
    if not m: continue
    qid, run = int(m.group(1)), m.group(2) or "r0"
    try:
        r = json.load(open(f))
    except Exception:
        continue
    if not r.get("ok"): continue
    v = r.get("value") or {}
    val = v.get("validation") or {}
    RUNS.setdefault(qid, []).append({
        "run": run, "file": f, "kind": v.get("kind"), "status": val.get("status"),
        "repairs": val.get("repairAttempts"), "message": v.get("message") or "",
        "warnings": (r.get("metadata") or {}).get("warnings") or [],
        "thinking": v.get("thinking") or "",
        "view": (v.get("results") or [{}])[0].get("title") if v.get("results") else None,
    })

GOLDEN = "tools/eval/shahy-onboarding/questions-and-answers.md"
text = open(GOLDEN, encoding="utf-8").read()
QA = {}
cur = None
for m in re.finditer(r"^### (\d+)\. (.+)$\n([\s\S]*?)(?=\n### |\n## |\Z)", text, re.M):
    QA[int(m.group(1))] = {"q": m.group(2).strip(), "ref": m.group(3).strip()[:900]}

ORDER = { "SUPPORTED": 0, "UNRESOLVED": 1 }
out = []
for qid in sorted(RUNS):
    runs = sorted(RUNS[qid], key=lambda r: (ORDER.get(r["status"], 2), len(r["message"])))
    best = runs[0]
    qa = QA.get(qid, {})
    out.append((qid, qa.get("q", "?"), qa.get("ref", ""), best, runs))

lines = ["# Answerable-today eval — Q&A log", "",
         f"Generated {datetime.datetime.now().isoformat(timespec='seconds')}. Server: dev :4317, model glm-5.3-flash:cloud,",
         "revision wt-bef42c4faa598b10 (shahy-restructure, semantic-ir-v2 with IR vectors + 891 concepts).",
         "Runs: r0 = pre-fix pilot (old prompts, flat 180s deadline); r1 = IR tools live, old prompts;",
         "r3 = IR-first prompts + read_observation gate; r4 = writer history compaction + flat 150s review floor;",
         "r5 = token-efficiency pass (classify/choose caps + JSON salvage, find_code/read_module result caps,",
         "narration fence elision, dynamic review reserve). Best result per question shown; all attempts listed.", ""]
for qid, q, ref, best, runs in out:
    lines.append(f"## Q{qid}. {q}")
    lines.append("")
    lines.append(f"**Best result (run {best['run']})**: kind=`{best['kind']}` validation=`{best['status']}` repairs={best['repairs']} view={best['view'] or '—'}")
    lines.append("")
    lines.append("**CIE's answer:**")
    lines.append("")
    lines.append("```")
    lines.append(best["message"][:2400])
    lines.append("```")
    lines.append("")
    lines.append("**Reference answer (golden):**")
    lines.append("")
    lines.append("```")
    lines.append(ref)
    lines.append("```")
    lines.append("")
    lines.append(f"*All attempts: " + "; ".join(f"`{r['run']}`: {r['status'] or r['kind']} (repairs {r['repairs']})" for r in runs) + "*")
    lines.append("")
print("\n".join(lines))