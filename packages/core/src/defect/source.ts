// A small, honest scanner over one function's source (TypeScript, Rust, Java, Go or Python). It is not a parser and not a control-flow graph:
// it understands braces, loops, `if` conditions, awaits, calls, and the common ways locks are taken and released, which is
// enough to find candidates and to say exactly what it could not see. Everything it reports is a position in the text, so
// every finding can point at the characters it came from. What it does not model is listed in LIMITS and travels with findings.
export type Lang = "ts" | "rust" | "java" | "go" | "python";
export type LockKind = "blocking" | "try" | "timeout" | "scoped";

export const LIMITS = [
  "lock identity is the written expression, so two names for one lock, or one name for two locks, are not distinguished",
  "branches are not path-sensitive: a lock taken in one branch is treated as held afterwards",
  "dynamic dispatch, callbacks passed as arguments and calls through values are not followed",
  "whether two entry points can really run at the same time is not established",
];

const ACQUIRE = new Set(["acquire", "lock", "wait", "lockAsync", "write", "read", "Lock", "RLock", "Acquire", "rlock"]);
const TRY = new Set(["tryAcquire", "tryLock", "try_lock", "try_write", "try_read", "TryLock", "TryRLock"]);
const RELEASE = new Set(["release", "unlock", "Unlock", "RUnlock", "Release"]);
const SCOPED = new Set(["runExclusive", "withLock", "exclusive", "synchronized", "withWriteLock", "withReadLock"]);
const ITER = new Set(["forEach", "map", "flatMap", "filter", "reduce", "some", "every", "find"]);
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "await", "async", "super", "import", "throw", "delete", "void", "yield", "match", "loop", "this", "func", "go", "defer", "select", "assert", "elif", "lambda", "with", "not", "except"]);
const NOISE = new Set(["unwrap", "expect", "clone", "into", "from", "iter", "collect", "to_string", "toString", "then", "catch", "finally", "Some", "Ok", "Err", "Box", "Arc", "Vec", "Promise", "all", "allSettled", "race", "resolve", "reject"]);

export interface Held { lock: string; kind: LockKind; guard?: string; depth: number; scoped: boolean; raii: boolean }
export interface Acquisition { lock: string; raw: string; kind: LockKind; at: number; line: number; heldBefore: string[]; guard?: string; aliasUncertain: boolean; reentrant: boolean }
export interface Call { name: string; receiver?: string; method?: string; at: number; line: number; held: string[]; loops: number[]; awaited: boolean; binding?: string; args: string; text: string }
export interface Loop { id: number; kind: "for" | "while" | "iter" | "loop"; header: string; at: number; line: number; headerEnd: number; bodyStart: number; bodyEnd: number; held: string[]; iterable?: string }
export interface IfBlock { at: number; line: number; cond: string; bodyStart: number; bodyEnd: number }
export interface Await { at: number; line: number; held: string[] }
export interface Release { lock: string; at: number }
export interface Scan { acquisitions: Acquisition[]; calls: Call[]; loops: Loop[]; ifs: IfBlock[]; awaits: Await[]; releases: Release[]; params: string[]; locksHeldAtEnd: string[]; unmatchedReleases: number }

/** Replace comments and string contents with spaces, keeping every offset and newline, so patterns cannot match inside them. */
export function blank(src: string, lang: Lang = "ts", keepStrings = false): string {
  const out = src.split(""); const n = src.length; let i = 0;
  const wipe = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  const py = lang === "python";
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (!py && c === "/" && d === "/") { let j = i; while (j < n && src[j] !== "\n") j++; wipe(i, j); i = j; continue; }
    if (!py && c === "/" && d === "*") { let j = src.indexOf("*/", i + 2); j = j < 0 ? n : j + 2; wipe(i, j); i = j; continue; }
    if (py && c === "#") { let j = i; while (j < n && src[j] !== "\n") j++; wipe(i, j); i = j; continue; }
    // Triple-quoted strings (Python docstrings, Java text blocks) can span lines and hold quotes.
    if ((py || lang === "java") && (c === '"' || (py && c === "'")) && src[i + 1] === c && src[i + 2] === c) {
      let j = src.indexOf(c.repeat(3), i + 3); j = j < 0 ? n : j;
      if (!keepStrings) wipe(i + 3, j); i = Math.min(n, j + 3); continue;
    }
    if (!keepStrings && (c === '"' || (c === "'" && !(lang === "rust" && /[A-Za-z_]/.test(src[i + 1] ?? "") && src[i + 2] !== "'")) || (c === "`" && !py))) {
      let j = i + 1;
      while (j < n && src[j] !== c && !(c !== "`" && src[j] === "\n")) { if (src[j] === "\\") j++; j++; }
      wipe(i + 1, Math.min(j, n)); i = j + 1; continue;
    }
    i++;
  }
  return out.join("");
}

const lineAt = (src: string, at: number) => { let n = 1; for (let i = 0; i < at && i < src.length; i++) if (src[i] === "\n") n++; return n; };
function balanced(s: string, open: number): number {
  const o = s[open], c = o === "(" ? ")" : o === "[" ? "]" : "}";
  let d = 0;
  for (let i = open; i < s.length; i++) { if (s[i] === o) d++; else if (s[i] === c) { d--; if (d === 0) return i; } }
  return -1;
}
/** `{` index → matching `}` index, for every brace. */
function braceMap(s: string): Map<number, number> {
  const m = new Map<number, number>(); const st: number[] = [];
  for (let i = 0; i < s.length; i++) { if (s[i] === "{") st.push(i); else if (s[i] === "}") { const o = st.pop(); if (o !== undefined) m.set(o, i); } }
  return m;
}
const norm = (e: string) => e.replace(/\s+/g, "").replace(/^(?:await)/, "").replace(/^this\./, "").replace(/^self\./, "").replace(/^&(?:mut)?/, "").replace(/\?\./g, ".");

/** Scan one function body (the text of the function, braces included). Offsets are relative to the start of `src`. */
export function scanFunction(src: string, lang: Lang = "ts"): Scan {
  const s = blank(src, lang);
  const params = (() => { const m = lang === "rust" ? /fn\s+\w+\s*(?:<[^>]*>)?\s*\(([^)]*)\)/.exec(s) : /(?:function\s*\*?\s*\w*|\w+\s*=\s*(?:async\s*)?|async\s+\w+|^\s*\w+)\s*\(([^)]*)\)/.exec(s); return (m?.[1] ?? "").split(",").map((x) => x.trim().replace(/^(?:mut\s+|&mut\s+|&\s*)/, "").split(/[:?=\s]/)[0]).filter(Boolean); })();
  const braces = braceMap(s);
  const res: Scan = { acquisitions: [], calls: [], loops: [], ifs: [], awaits: [], releases: [], params, locksHeldAtEnd: [], unmatchedReleases: 0 };

  // Pass 1: loops and `if` blocks as position ranges.
  const loopRe = /\b(for|while|loop)\b\s*(?:await\s*)?/g; let m: RegExpExecArray | null;
  while ((m = loopRe.exec(s))) {
    const kind = m[1] as "for" | "while" | "loop"; let p = m.index + m[0].length;
    let header = "", headerEnd = p;
    if (kind !== "loop" || lang !== "rust") {
      if (s[p] === "(") { const close = balanced(s, p); if (close < 0) continue; header = s.slice(p + 1, close); headerEnd = close + 1; p = headerEnd; }
      else if (lang === "rust" && kind !== "loop") { const brace = s.indexOf("{", p); if (brace < 0) continue; header = s.slice(p, brace); headerEnd = brace; p = brace; }
      else continue;
    } else { header = ""; headerEnd = p; }
    while (/\s/.test(s[p] ?? "")) p++;
    let bodyStart = p, bodyEnd: number;
    if (s[p] === "{") bodyEnd = braces.get(p) ?? s.length;
    else { const semi = s.indexOf(";", p); bodyEnd = semi < 0 ? s.length : semi + 1; }
    const iterable = kind === "for" ? (/(?:of|in)\s+([^)]+)$/.exec(header)?.[1] ?? undefined) : undefined;
    res.loops.push({ id: res.loops.length, kind, header: header.trim(), at: m.index, line: lineAt(src, m.index), headerEnd, bodyStart, bodyEnd, held: [], iterable: iterable?.trim() });
  }
  const ifRe = /\bif\s*(?:let\s+[^=]+=\s*)?\(/g;
  while ((m = ifRe.exec(s))) {
    const open = m.index + m[0].length - 1; const close = balanced(s, open); if (close < 0) continue;
    let p = close + 1; while (/\s/.test(s[p] ?? "")) p++;
    if (s[p] === "{") res.ifs.push({ at: m.index, line: lineAt(src, m.index), cond: s.slice(open + 1, close), bodyStart: p, bodyEnd: braces.get(p) ?? s.length });
  }

  // Pass 2: in textual order, locks (held set), awaits and calls.
  const held: Held[] = []; const pendingScoped: { lock: string; kind: LockKind }[] = [];
  const snapshot = () => held.map((h) => h.lock);
  let depth = 0; let last = 0;
  const callRe = /(?:(\bawait)\s+)?([A-Za-z_$][\w$]*(?:\s*(?:\?\.|\.|::)\s*[A-Za-z_$][\w$]*|\s*\[[^\]\n]*\])*)\s*(\()|(\bawait\b)|([{}])/g;
  const inLoops = (at: number) => res.loops.filter((l) => at >= l.bodyStart && at < l.bodyEnd).map((l) => l.id);
  const stmtStart = (at: number) => { let i = at - 1; while (i >= 0 && !";{}".includes(s[i])) i--; return i + 1; };
  while ((m = callRe.exec(s))) {
    if (m[5] === "{") {
      depth++;
      const sc = pendingScoped.shift();
      if (sc) held.push({ lock: sc.lock, kind: "scoped", depth, scoped: true, raii: false });
      continue;
    }
    if (m[5] === "}") {
      // Scoped locks end with their block; in Rust a guard also ends with the block it was bound in.
      for (let k = held.length - 1; k >= 0; k--) if ((held[k].scoped || held[k].raii) && held[k].depth >= depth) held.splice(k, 1);
      depth--; continue;
    }
    if (m[4]) { res.awaits.push({ at: m.index, line: lineAt(src, m.index), held: snapshot() }); continue; }
    if (m[1]) res.awaits.push({ at: m.index, line: lineAt(src, m.index), held: snapshot() });
    const chain = m[2].replace(/\s+/g, "").replace(/\?\./g, "."); const at = m.index; const open = m.index + m[0].length - 1;
    const cut = Math.max(chain.lastIndexOf("."), chain.lastIndexOf("::")); const method = cut >= 0 ? chain.slice(cut + (chain[cut] === ":" ? 2 : 1)) : chain; const receiver = cut >= 0 ? chain.slice(0, cut) : undefined;
    const close = balanced(s, open); const args = close < 0 ? "" : s.slice(open + 1, close);
    if (KEYWORDS.has(chain) && !(chain === "match")) { continue; }
    const prefix = s.slice(stmtStart(at), at);
    const bindM = /(?:const|let|var)\s+(?:mut\s+)?(\w+)\s*(?::[^=]+)?=\s*(?:await\s+)?$/.exec(prefix);
    const binding = bindM?.[1];
    const awaited = !!m[1] || /\bawait\s*$/.test(prefix);
    const raw = receiver ?? "";

    // Locks.
    const isTry = TRY.has(method), isAcq = (ACQUIRE.has(method) && receiver && !(lang === "ts" && (method === "write" || method === "read") && !/lock|mutex|guard/i.test(receiver))) || false;
    if (receiver && (isTry || isAcq)) {
      const timeout = /timeout|deadline/i.test(args);
      const kind: LockKind = isTry ? "try" : timeout ? "timeout" : "blocking";
      const lock = norm(receiver);
      const aliasUncertain = params.includes(lock.split(/[.[]/)[0]) || /[[(]/.test(receiver);
      const reentrant = held.some((h) => h.lock === lock);
      res.acquisitions.push({ lock, raw: receiver, kind, at, line: lineAt(src, at), heldBefore: snapshot(), guard: binding, aliasUncertain, reentrant });
      // Rust: `let g = x.lock().unwrap()` holds for the block; a temporary holds for the statement (ignored here).
      if (!isTry || binding) held.push({ lock, kind, guard: binding, depth, scoped: false, raii: lang === "rust" && !!binding });
      else if (isTry) held.push({ lock, kind, guard: binding, depth, scoped: false, raii: false });
      callRe.lastIndex = open + 1; continue;
    }
    if (receiver && RELEASE.has(method)) {
      const r = norm(receiver); let idx = -1;
      for (let k = held.length - 1; k >= 0; k--) if (held[k].guard === r || held[k].lock === r) { idx = k; break; }
      if (idx >= 0) { res.releases.push({ lock: held[idx].lock, at }); held.splice(idx, 1); } else res.unmatchedReleases++;
      callRe.lastIndex = open + 1; continue;
    }
    if (chain === "drop" && lang === "rust") {
      const g = args.trim(); const idx = held.findIndex((h) => h.guard === g);
      if (idx >= 0) { res.releases.push({ lock: held[idx].lock, at }); held.splice(idx, 1); }
      callRe.lastIndex = open + 1; continue;
    }
    if (SCOPED.has(method)) {
      const lock = receiver ? norm(receiver) : norm(args.split(",")[0] ?? "");
      const brace = s.indexOf("{", open);
      const argsEnd = close < 0 ? s.length : close;
      if (brace >= 0 && brace < argsEnd) {
        // The callback body is a block inside the arguments; the lock is held for exactly that block.
        const bodyOpen = brace;
        res.acquisitions.push({ lock, raw: receiver ?? args, kind: "scoped", at, line: lineAt(src, at), heldBefore: snapshot(), aliasUncertain: params.includes(lock.split(/[.[]/)[0]), reentrant: held.some((h) => h.lock === lock) });
        pendingScoped.push({ lock, kind: "scoped" });
        void bodyOpen;
      }
      callRe.lastIndex = open + 1; continue;
    }
    if (ITER.has(method) && receiver) {
      const bodyStart = open + 1; const bodyEnd = close < 0 ? s.length : close;
      if (/=>|function/.test(args)) res.loops.push({ id: res.loops.length, kind: "iter", header: `${receiver}.${method}`, at, line: lineAt(src, at), headerEnd: bodyStart, bodyStart, bodyEnd, held: snapshot(), iterable: receiver });
    }
    if (NOISE.has(method) && !receiver) { callRe.lastIndex = open + 1; continue; }
    res.calls.push({ name: method, receiver, method, at, line: lineAt(src, at), held: snapshot(), loops: inLoops(at), awaited, binding, args, text: s.slice(at, close < 0 ? open + 1 : close + 1) });
    callRe.lastIndex = open + 1;
    last = open;
  }
  void last;
  for (const l of res.loops) l.held = res.acquisitions.filter((a) => a.at < l.at).length ? l.held : l.held;
  res.locksHeldAtEnd = snapshot();
  // Loop membership for calls recorded before their loop was known (iteration helpers add loops during the scan).
  for (const c of res.calls) c.loops = res.loops.filter((l) => c.at >= l.bodyStart && c.at < l.bodyEnd).map((l) => l.id);
  return res;
}
