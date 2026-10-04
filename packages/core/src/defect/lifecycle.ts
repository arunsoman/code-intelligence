// Lifecycle analysis (C26): something is opened, so something must close it. Timers, file handles, pooled connections, transactions
// and listeners each have an opening and a closing call; the detector follows one function at a time and records a timeline for
// each resource: where it was opened, where it was closed, and whether it was handed to someone else (returned or stored), in which
// case closing it is theirs to do. A leak here is a candidate: ownership transfers the scanner cannot see, or a deliberately permanent
// subscription, look the same as a leak.
import { createHash } from "node:crypto";
import type { DetectorFinding, SafetyObligation, SourceSpan } from "@cie/schema";
import type { RevisionRow, Store } from "../store.ts";
import { blank, LIMITS, type Lang } from "./source.ts";
import { fileLine, loadFunctions, spanEvidence, spanOf, type Fn } from "./functions.ts";

const h = (...p: unknown[]) => createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 16);
interface Kind { id: string; langs: Lang[]; open: RegExp; close: (name: string, ev?: string) => RegExp; noun: string; needsHandle: boolean }
const TSR: Lang[] = ["ts", "rust"];
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KINDS: Kind[] = [
  { id: "timer", langs: TSR, noun: "timer", needsHandle: true, open: /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:global\.|window\.)?setInterval\s*\(/g, close: (n) => new RegExp(`clearInterval\\s*\\(\\s*${n}\\s*\\)`) },
  { id: "file", langs: TSR, noun: "file handle", needsHandle: true, open: /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:fs\.|fsp\.)?(?:openSync|open|createReadStream|createWriteStream)\s*\(/g, close: (n) => new RegExp(`(?:closeSync|close)\\s*\\(\\s*${n}\\s*\\)|\\b${n}\\.(?:close|destroy|end)\\s*\\(`) },
  { id: "connection", langs: TSR, noun: "pooled connection", needsHandle: true, open: /\b(?:const|let|var)\s+(\w+)\s*=\s*await\s+[\w.]+\.(?:connect|getConnection|checkout)\s*\(/g, close: (n) => new RegExp(`\\b${n}\\.(?:release|end|close|destroy)\\s*\\(`) },
  { id: "transaction", langs: TSR, noun: "transaction", needsHandle: false, open: /\b([\w.]*?)\.?(?:begin|startTransaction|beginTransaction)\s*\(\s*\)/g, close: () => /\.(?:commit|rollback)\s*\(/ },
  { id: "listener", langs: TSR, noun: "event listener", needsHandle: false, open: /\b([\w.]+)\.(?:addEventListener|addListener)\s*\(\s*['"`]?(\w+)/g, close: (_n, ev) => new RegExp(`\\.(?:removeEventListener|removeListener|off)\\s*\\(\\s*['"\`]?${ev ?? "\\w+"}`) },
  // ---- Java
  { id: "file", langs: ["java"], noun: "stream or reader", needsHandle: true, open: /\b\w+(?:<[^>]*>)?\s+(\w+)\s*=\s*new\s+(?:File(?:Input|Output)Stream|FileReader|FileWriter|BufferedReader|BufferedWriter|Scanner|RandomAccessFile|Socket|ServerSocket|ObjectInputStream|ObjectOutputStream)\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\.close\\s*\\(`) },
  { id: "connection", langs: ["java"], noun: "database connection", needsHandle: true, open: /\bConnection\s+(\w+)\s*=\s*[\w.()]*?getConnection\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\.close\\s*\\(`) },
  { id: "executor", langs: ["java"], noun: "thread pool", needsHandle: true, open: /\b(?:ExecutorService|ScheduledExecutorService|ThreadPoolExecutor)\s+(\w+)\s*=\s*Executors\.new\w+\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\.(?:shutdown|shutdownNow|close)\\s*\\(`) },
  { id: "lock", langs: ["java"], noun: "lock", needsHandle: true, open: /\b([\w.]+)\.(?:lock|lockInterruptibly)\s*\(\s*\)/g, close: (n) => new RegExp(`\\b${esc(n)}\\.unlock\\s*\\(`) },
  // ---- Go
  { id: "file", langs: ["go"], noun: "file", needsHandle: true, open: /\b(\w+)(?:\s*,\s*\w+)?\s*:?=\s*os\.(?:Open|Create|OpenFile)\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\.Close\\s*\\(`) },
  { id: "rows", langs: ["go"], noun: "query result set", needsHandle: true, open: /\b(\w+)(?:\s*,\s*\w+)?\s*:?=\s*[\w.]+\.(?:Query|QueryContext)\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\.Close\\s*\\(`) },
  { id: "response", langs: ["go"], noun: "HTTP response body", needsHandle: true, open: /\b(\w+)(?:\s*,\s*\w+)?\s*:?=\s*http\.(?:Get|Post|Head|PostForm)\s*\(|\b(\w+)(?:\s*,\s*\w+)?\s*:?=\s*[\w.]+\.Do\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\.Body\\.Close\\s*\\(`) },
  { id: "ticker", langs: ["go"], noun: "ticker", needsHandle: true, open: /\b(\w+)\s*:?=\s*time\.NewTicker\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\.Stop\\s*\\(`) },
  { id: "context", langs: ["go"], noun: "cancellable context", needsHandle: true, open: /\b\w+\s*,\s*(\w+)\s*:?=\s*context\.With(?:Cancel|Timeout|Deadline)\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\s*\\(\\s*\\)`) },
  { id: "lock", langs: ["go"], noun: "mutex", needsHandle: true, open: /\b([\w.]+)\.(?:Lock|RLock)\s*\(\s*\)/g, close: (n) => new RegExp(`\\b${esc(n)}\\.(?:Unlock|RUnlock)\\s*\\(`) },
  // ---- Python
  { id: "file", langs: ["python"], noun: "file", needsHandle: true, open: /(?<![\w.])(\w+)\s*=\s*(?:io\.|codecs\.)?open\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\.close\\s*\\(`) },
  { id: "connection", langs: ["python"], noun: "connection", needsHandle: true, open: /(?<![\w.])(\w+)\s*=\s*(?:await\s+)?[\w.]*\.?(?:connect|create_connection|get_connection)\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\.(?:close|disconnect)\\s*\\(`) },
  { id: "lock", langs: ["python"], noun: "lock", needsHandle: true, open: /\b([\w.]+)\.acquire\s*\(/g, close: (n) => new RegExp(`\\b${esc(n)}\\.release\\s*\\(`) },
];

export function detectLifecycle(store: Store, rev: RevisionRow, opts: { entityIds?: string[] } = {}): DetectorFinding[] {
  const fns = loadFunctions(store, rev); const out: DetectorFinding[] = [];
  for (const f of fns.values()) {
    if (opts.entityIds?.length && !opts.entityIds.includes(f.entity.entityId)) continue;
    const s = blank(f.src, f.lang, true);
    const finallyRanges: [number, number][] = [];
    // Go's `defer` runs when the function returns, whatever path it took: the equivalent of a finally block. Python's `finally:` is an indented block.
    if (f.lang === "go") for (const m of s.matchAll(/^[ \t]*defer\b[^\n]*/gm)) finallyRanges.push([m.index!, m.index! + m[0].length]);
    if (f.lang === "python") {
      const ls = s.split("\n"); let off = 0;
      for (let i = 0; i < ls.length; i++) { const t = ls[i]; if (/^\s*finally\s*:/.test(t)) { const ind = t.length - t.trimStart().length; let end = off + t.length; for (let j = i + 1; j < ls.length; j++) { if (ls[j].trim() === "") { end += ls[j].length + 1; continue; } if (ls[j].length - ls[j].trimStart().length <= ind) break; end += ls[j].length + 1; } finallyRanges.push([off, end]); } off += t.length + 1; }
    }
    for (const m of s.matchAll(/\bfinally\s*\{/g)) { const open = m.index! + m[0].length - 1; let d = 0, i = open; for (; i < s.length; i++) { if (s[i] === "{") d++; else if (s[i] === "}" && --d === 0) break; } finallyRanges.push([open, i]); }
    const inFinally = (at: number) => finallyRanges.some(([a, b]) => at > a && at < b);
    for (const k of KINDS) {
      if (!k.langs.includes(f.lang)) continue;
      for (const m of s.matchAll(k.open)) {
        const name = k.needsHandle ? (m[1] ?? m[2]) : (m[1] || "(resource)"); const ev = k.id === "listener" ? m[2] : undefined;
        const at = m.index!;
        // Java try-with-resources closes what it opens: `try (Reader r = new ...)` is not a leak.
        if (f.lang === "java" && /\btry\s*\([^)]*$/.test(s.slice(Math.max(0, at - 200), at))) continue;
        const rest = s.slice(at + m[0].length);
        const closeM = k.close(name, ev).exec(rest);
        const closeAt = closeM ? at + m[0].length + closeM.index : -1;
        // Handed to someone else: returned, stored on an object, pushed into a collection, or passed along.
        // Ownership moves when the handle itself is returned, stored on an object, added to a collection, wrapped by a constructor, or given to
        // something named for taking ownership. Passing it to a function that merely uses it (a read, a query) does not.
        const escapes = k.needsHandle && (new RegExp(`\\breturn\\s+(?:${name}\\b\\s*(?:;|$|\\})|[\\[{][^;]*\\b${name}\\b)`, "m").test(rest) || new RegExp(`(?:this|\\w+)\\.\\w+\\s*=\\s*${name}\\b|\\.(?:push|set|add)\\s*\\([^)]*\\b${name}\\b|\\bnew\\s+\\w+\\s*\\([^)]*\\b${name}\\b|\\b(?:register|own|track|store|adopt|manage|attach|keep|hold)\\w*\\s*\\([^)]*\\b${name}\\b`).test(rest));
        const returnsCleanup = k.id === "listener" && /return\s+(?:\(\)|[\w]+\s*=>|\(\)\s*=>)/.test(rest);
        const between = closeAt >= 0 ? s.slice(at, closeAt) : rest;
        const mayFailBetween = (f.lang === "go" ? /\breturn\b|\bpanic\s*\(/ : f.lang === "python" ? /\braise\b|\w\s*\(/ : /\bawait\b|\bthrow\b|\w\s*\(/).test(between.slice(m[0].length));
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
