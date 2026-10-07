// Names a question mentions, looked up in the index before any model reads the question. "What is MiFilter" is a lookup
// of `MiFilter`, not a choice of picture: the words that look like code (CamelCase, snake_case, dotted, paths) are matched
// against the revision's symbols and files, exactly first, then with a small edit distance for typos. Plain English words
// only count when they equal a whole class, type, function or file name. Nothing matched is reported as such, never guessed.
import type { Entity } from "@cie/schema";
import type { AccessPolicy } from "./access.ts";
import type { Store } from "./store.ts";

export interface MentionMatch { entityId: string; name: string; kind: string; file: string }
export interface Mention { text: string; how: "exact" | "fuzzy"; matches: MentionMatch[] }
export interface Mentions { resolved: Mention[]; /** Code-shaped words with no match in this revision. */ unresolved: string[] }

const MAX_MATCHES = 5;
const KIND_ORDER: Record<string, number> = { class: 0, interface: 1, type: 2, function: 3, file: 4, method: 5, test: 6 };
const WHOLE_NAME_KINDS = new Set(["class", "interface", "type", "function", "file"]);
const STOP = new Set(["what", "whats", "which", "where", "when", "does", "this", "that", "with", "from", "about", "show", "tell", "explain", "describe", "work", "works", "used", "uses", "code", "file", "files", "class", "function", "method", "module", "test", "tests", "have", "there", "their", "they", "them", "then", "than", "into", "also", "just", "like", "some", "more", "most", "much", "many", "should", "would", "could", "every", "each", "other", "here", "role", "purpose", "job", "risky", "risk", "change", "changes"]);

/** Looks like an identifier rather than an English word: an inner capital, an underscore, a dot, a slash, `#` or `::`. */
export const codeShaped = (t: string) => /[a-z0-9][A-Z]|[A-Z]{2,}[a-z]|_|[./#]|::/.test(t);

interface NameIndex { keys: Map<string, Entity[]>; fuzzyKeys: string[] }
const cache = new Map<string, NameIndex>();

function nameIndex(store: Store, revision: string): NameIndex {
  const hit = cache.get(revision);
  if (hit) return hit;
  const keys = new Map<string, Entity[]>();
  const add = (k: string, e: Entity) => { if (k) keys.set(k, [...(keys.get(k) ?? []), e]); };
  for (const e of store.entities(revision)) {
    const name = e.name.toLowerCase();
    add(name, e);
    if (e.kind === "file") { add(e.file.toLowerCase(), e); add(name.replace(/\.[a-z0-9]+$/, ""), e); }
    else if (name.includes(".")) add(name.slice(name.lastIndexOf(".") + 1), e);
  }
  const index = { keys, fuzzyKeys: [...keys.keys()].filter((k) => k.length >= 4) };
  if (cache.size > 10) cache.clear();
  cache.set(revision, index);
  return index;
}

/** Edit distance, a swap of two neighbouring letters counting as one edit ("MiFliter"), with an early exit past `max`. */
export function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let before: number[] = [], prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], before[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    before = prev; prev = cur;
  }
  return prev[b.length] <= max;
}

/** The words of a question that could name code, in order, without trailing punctuation or a possessive. */
export function candidateWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;!?()[\]{}<>"'`“”‘’]+/)) {
    const t = raw.replace(/'s$|’s$/, "").replace(/^[^\w$./#]+|[^\w$]+$/g, "");
    if (t.length >= 3 && !out.includes(t)) out.push(t);
  }
  return out;
}

const rank = (a: Entity, b: Entity) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.file.length - b.file.length || a.name.localeCompare(b.name);

function matchesFor(found: Entity[], access: AccessPolicy): MentionMatch[] {
  const visible = found.filter((e) => !access.denied(e.file)).sort(rank);
  // A class and the file named after it are one thing; keep the class.
  const symbolFiles = new Set(visible.filter((e) => e.kind !== "file").map((e) => e.file));
  const unique = visible.filter((e, i) => visible.findIndex((x) => x.entityId === e.entityId) === i && !(e.kind === "file" && symbolFiles.has(e.file)));
  return unique.slice(0, MAX_MATCHES).map((e) => ({ entityId: e.entityId, name: e.name, kind: e.kind, file: e.file }));
}

export function resolveMentions(store: Store, revision: string, text: string, access: AccessPolicy): Mentions {
  const { keys, fuzzyKeys } = nameIndex(store, revision);
  const resolved: Mention[] = [], unresolved: string[] = [];
  for (const word of candidateWords(text)) {
    const lower = word.toLowerCase(), shaped = codeShaped(word);
    if (!shaped && (lower.length < 4 || STOP.has(lower))) continue;
    // An English word names code only when it is a whole name ("payments" the file, not "filter" the method of MiFilter).
    const exact = (keys.get(lower) ?? []).filter((e) => shaped || (WHOLE_NAME_KINDS.has(e.kind) && (e.name.toLowerCase() === lower || e.name.toLowerCase().replace(/\.[a-z0-9]+$/, "") === lower)));
    if (exact.length) { const matches = matchesFor(exact, access); if (matches.length) resolved.push({ text: word, how: "exact", matches }); else unresolved.push(word); continue; }
    if (!shaped) continue;
    const max = lower.length >= 12 ? 2 : 1;
    const near = fuzzyKeys.filter((k) => within(lower, k, max)).flatMap((k) => keys.get(k)!).filter((e) => WHOLE_NAME_KINDS.has(e.kind) || e.kind === "method");
    const matches = matchesFor(near, access);
    if (matches.length) resolved.push({ text: word, how: "fuzzy", matches }); else unresolved.push(word);
  }
  return { resolved, unresolved };
}
