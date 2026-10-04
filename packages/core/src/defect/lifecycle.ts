// Lifecycle analysis (C26): something is opened, so something must close it. Timers, file handles, pooled connections, transactions
// and listeners each have an opening and a closing call; the detector follows one function at a time and records a timeline for
// each resource: where it was opened, where it was closed, and whether it was handed to someone else (returned or stored), in which
// case closing it is theirs to do. A leak here is a candidate: ownership transfers the scanner cannot see, or a deliberately permanent
// subscription, look the same as a leak.
import { createHash } from "node:crypto";
import type { DetectorFinding, SafetyObligation, SourceSpan } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { blank, LIMITS } from "./source.ts";
import { fileLine, loadFunctions, spanEvidence, spanOf, type Fn } from "./functions.ts";

const h = (...p: unknown[]) => createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 16);
interface Kind { id: string; open: RegExp; close: (name: string, ev?: string) => RegExp; noun: string; needsHandle: boolean }
const KINDS: Kind[] = [
  { id: "timer", noun: "timer", needsHandle: true, open: /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:global\.|window\.)?setInterval\s*\(/g, close: (n) => new RegExp(`clearInterval\\s*\\(\\s*${n}\\s*\\)`) },
  { id: "file", noun: "file handle", needsHandle: true, open: /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:fs\.|fsp\.)?(?:openSync|open|createReadStream|createWriteStream)\s*\(/g, close: (n) => new RegExp(`(?:closeSync|close)\\s*\\(\\s*${n}\\s*\\)|\\b${n}\\.(?:close|destroy|end)\\s*\\(`) },
  { id: "connection", noun: "pooled connection", needsHandle: true, open: /\b(?:const|let|var)\s+(\w+)\s*=\s*await\s+[\w.]+\.(?:connect|getConnection|checkout)\s*\(/g, close: (n) => new RegExp(`\\b${n}\\.(?:release|end|close|destroy)\\s*\\(`) },
  { id: "transaction", noun: "transaction", needsHandle: false, open: /\b([\w.]*?)\.?(?:begin|startTransaction|beginTransaction)\s*\(\s*\)/g, close: () => /\.(?:commit|rollback)\s*\(/ },
  { id: "listener", noun: "event listener", needsHandle: false, open: /\b([\w.]+)\.(?:addEventListener|addListener)\s*\(\s*['"`]?(\w+)/g, close: (_n, ev) => new RegExp(`\\.(?:removeEventListener|removeListener|off)\\s*\\(\\s*['"\`]?${ev ?? "\\w+"}`) },
];

export function detectLifecycle(store: Store, rev: RevisionRow, opts: { entityIds?: string[] } = {}): DetectorFinding[] {
  const fns = loadFunctions(store, rev); const out: DetectorFinding[] = [];
  for (const f of fns.values()) {
    if (opts.entityIds?.length && !opts.entityIds.includes(f.entity.entityId)) continue;
    const s = blank(f.src, f.lang, true);
    const finallyRanges: [number, number][] = [];
    for (const m of s.matchAll(/\bfinally\s*\{/g)) { const open = m.index! + m[0].length - 1; let d = 0, i = open; for (; i < s.length; i++) { if (s[i] === "{") d++; else if (s[i] === "}" && --d === 0) break; } finallyRanges.push([open, i]); }
    const inFinally = (at: number) => finallyRanges.some(([a, b]) => at > a && at < b);
    for (const k of KINDS) {
      for (const m of s.matchAll(k.open)) {
        const name = k.needsHandle ? m[1] : (m[1] || "(resource)"); const ev = k.id === "listener" ? m[2] : undefined;
        const at = m.index!;
        const rest = s.slice(at + m[0].length);
        const closeM = k.close(name, ev).exec(rest);
        const closeAt = closeM ? at + m[0].length + closeM.index : -1;
        // Handed to someone else: returned, stored on an object, pushed into a collection, or passed along.
        // Ownership moves when the handle itself is returned, stored on an object, added to a collection, wrapped by a constructor, or given to
        // something named for taking ownership. Passing it to a function that merely uses it (a read, a query) does not.
        const escapes = k.needsHandle && (new RegExp(`\\breturn\\s+(?:${name}\\b\\s*(?:;|$|\\})|[\\[{][^;]*\\b${name}\\b)`, "m").test(rest) || new RegExp(`(?:this|\\w+)\\.\\w+\\s*=\\s*${name}\\b|\\.(?:push|set|add)\\s*\\([^)]*\\b${name}\\b|\\bnew\\s+\\w+\\s*\\([^)]*\\b${name}\\b|\\b(?:register|own|track|store|adopt|manage|attach|keep|hold)\\w*\\s*\\([^)]*\\b${name}\\b`).test(rest));
        const returnsCleanup = k.id === "listener" && /return\s+(?:\(\)|[\w]+\s*=>|\(\)\s*=>)/.test(rest);
        const between = closeAt >= 0 ? s.slice(at, closeAt) : rest;
        const mayFailBetween = /\bawait\b|\bthrow\b|\w\s*\(/.test(between.slice(m[0].length));
        const timeline = [{ event: "opened", line: fileLine(store, rev, f, at) }, ...(closeAt >= 0 ? [{ event: inFinally(closeAt) ? "closed in finally" : "closed", line: fileLine(store, rev, f, closeAt) }] : []), ...(escapes ? [{ event: "handed to the caller or stored" }] : [])];
        let problem: string | null = null, severity: DetectorFinding["severity"] = "MEDIUM";
        if (closeAt < 0 && !escapes && !returnsCleanup) { problem = `${/^[aeiou]/.test(k.noun) ? "An" : "A"} ${k.noun}${k.needsHandle ? ` (${name})` : ""} is opened and not closed in this function, and it is not handed to anyone else.`; severity = k.id === "listener" ? "LOW" : "MEDIUM"; }
        else if (closeAt >= 0 && !inFinally(closeAt) && mayFailBetween && !escapes && k.id !== "transaction" && k.id !== "listener") { problem = `${/^[aeiou]/.test(k.noun) ? "An" : "A"} ${k.noun} (${name}) is closed on the normal path only: if something between opening and closing fails, it stays open.`; severity = "LOW"; }
        else if (k.id === "transaction" && closeAt >= 0 && !/rollback/.test(s.slice(at)) && /\bawait\b/.test(between)) { problem = `A transaction commits but is never rolled back if the work between begin and commit fails.`; severity = "MEDIUM"; }
        if (!problem) continue;
        const ev2 = spanEvidence(store, rev, f, at, Math.max(8, m[0].length));
        const sp = spanOf(f, at, m[0].length);
        const span: SourceSpan = { sourceId: f.file, contentHash: f.fileHash, revision: rev.id, startByte: sp.startByte, endByteExclusive: sp.endByte };
        const obligations: SafetyObligation[] = ["Every path out of the function, including the error path, closes it, or ownership is explicitly handed over.", "Closing earlier does not break a caller that still uses the resource."].map((d) => ({ id: "obl:" + h(k.id, d), description: d, predicateSchemaId: `defect.obligation.lifecycle-${k.id}.v1`, state: "PENDING" as const, evidenceIds: [] }));
        out.push({
          id: "finding:" + h("defect.resource-lifecycle", rev.id, f.entity.entityId, k.id, at), version: 1, kind: "RESOURCE_LEAK", revision: rev.id, entityIds: [f.entity.entityId], spans: [span],
          ruleId: "defect.resource-lifecycle", ruleVersion: 1, evidenceIds: [ev2.id], severity, evidenceLevel: "STATIC_CANDIDATE", safetyObligations: obligations,
          coverageGaps: ["Whether the handle is closed by a caller, a framework or at process exit is not visible from this function.", ...(k.id === "listener" ? ["A subscription that is meant to last for the life of the process looks the same as a leaked one."] : []), ...LIMITS.slice(1, 2)],
          witness: { kind: "RESOURCE_TIMELINE", paths: [[f.entity.entityId, k.id, name]], detail: `${problem} Timeline: ${timeline.map((t) => `${t.event}${"line" in t ? ` (line ${t.line})` : ""}`).join(" → ")}. This is a static candidate: no leak was observed.` },
        });
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
