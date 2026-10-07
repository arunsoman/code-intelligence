// Candidate trees with more than text (issue #91): binary files, executable bits and symlinks, held beside the text the candidate
// engine already stored. Git is the canonical diff and apply engine for these (patch-export.ts); this file only describes entries,
// copies and compares trees, and writes a candidate into a directory.
//
// Rules that hold everywhere a tree is copied or written:
//   * A symlink is allowed only if its target is relative and stays inside the repository, never reaches version-control metadata, and no path
//     passes THROUGH a symlink (a write through a link could land somewhere the admission rules never looked).
//   * The mode is 100644 or 100755 for files and 120000 for links. A gitlink (160000) is never produced.
//   * Skipped directories (node_modules, .git, build output) are not part of a candidate, exactly as before.
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { rawHash } from "./canon.ts";
import { sha256, safeJoin, SKIP_RE } from "../isolated-exec.ts";
import type { CandidateEntry, CandidateRecord } from "./types.ts";

export const MAX_BINARY_BYTES = 2 * 1024 * 1024, MAX_SYMLINK_TARGET = 1024;
export type Mode = "100644" | "100755" | "120000";
export const FILE_MODES: readonly Mode[] = ["100644", "100755"];

/** A file is text when it is valid UTF-8 without NUL bytes; anything else is binary and travels as bytes. */
export function isTextBytes(b: Buffer): boolean { if (b.includes(0)) return false; const t = b.toString("utf8"); return Buffer.from(t, "utf8").equals(b); }

export const symlinkHash = (target: string): string => sha256(`symlink:${target}`);

/** Why `target`, written at `linkRel`, may not be a symlink target; undefined when it may. */
export function symlinkProblem(linkRel: string, target: string): string | undefined {
  if (typeof target !== "string" || !target) return "a symlink needs a target";
  if (target.length > MAX_SYMLINK_TARGET) return `a symlink target is at most ${MAX_SYMLINK_TARGET} characters`;
  if (/[\0\r\n]/.test(target) || target.includes("\\")) return "a symlink target has a control or backslash character";
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) return "a symlink target must be relative";
  const resolved = posix.normalize(posix.join(posix.dirname(linkRel), target));
  if (resolved === "." || resolved === ".." || resolved.startsWith("../")) return "a symlink target must stay inside the repository";
  if (resolved.split("/").some((s) => /^(\.git|\.gitmodules)$/i.test(s))) return "a symlink may not point into version-control metadata";
  return undefined;
}

export interface Meta { kind: "FILE" | "SYMLINK"; mode: Mode; hash: string; size: number }
const modeOf = (st: { mode: number }): Mode => (st.mode & 0o111 ? "100755" : "100644");

/** Every entry of a tree, keyed by relative path, skipped directories left out; symlinks are recorded, never followed. */
export function listMeta(root: string, cap = 100_000): Map<string, Meta> {
  const out = new Map<string, Meta>();
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_RE.test(name)) continue;
      const abs = join(dir, name), r = rel ? `${rel}/${name}` : name, st = lstatSync(abs);
      if (st.isSymbolicLink()) { const t = readlinkSync(abs); out.set(r, { kind: "SYMLINK", mode: "120000", hash: symlinkHash(t), size: Buffer.byteLength(t) }); }
      else if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) out.set(r, { kind: "FILE", mode: modeOf(st), hash: rawHash(readFileSync(abs)), size: st.size });
      else throw new Error(`special file ${r} cannot be part of a candidate`);
      if (out.size > cap) throw new Error("too many files");
    }
  };
  walk(root, ""); return out;
}

export interface TreeDelta { file: string; kind: "ADDED" | "MODIFIED" | "DELETED"; before?: Meta; after?: Meta }
/** Sorted differences between two trees: content, mode or kind (file versus link) all count. */
export function diffTrees(baseRoot: string, headRoot: string): TreeDelta[] {
  const b = listMeta(baseRoot), h = listMeta(headRoot); const out: TreeDelta[] = [];
  for (const file of [...new Set([...b.keys(), ...h.keys()])].sort()) {
    const x = b.get(file), y = h.get(file);
    if (x && y) { if (x.kind !== y.kind || x.mode !== y.mode || x.hash !== y.hash) out.push({ file, kind: "MODIFIED", before: x, after: y }); }
    else if (y) out.push({ file, kind: "ADDED", after: y }); else out.push({ file, kind: "DELETED", before: x });
  }
  return out;
}

/** The payload of one entry as the candidate keeps it: text lives in `contents`, so a TEXT entry carries only its mode and hash. */
export function readEntry(root: string, rel: string): CandidateEntry | null {
  const abs = safeJoin(root, rel); let st; try { st = lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink()) { const target = readlinkSync(abs); return { kind: "SYMLINK", mode: "120000", hash: symlinkHash(target), size: Buffer.byteLength(target), target }; }
  if (!st.isFile()) return null;
  const bytes = readFileSync(abs), text = isTextBytes(bytes);
  return { kind: text ? "TEXT" : "BINARY", mode: modeOf(st), hash: rawHash(bytes), size: bytes.length, ...(text ? {} : { base64: bytes.toString("base64") }) };
}

/** Copy a checkout keeping symlinks and modes. An escaping symlink or a special file is refused, never followed. */
export function copyTreeKeepLinks(src: string, dst: string): void {
  const walk = (from: string, to: string, rel: string) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from).sort()) {
      if (SKIP_RE.test(name)) continue;
      const a = join(from, name), b = join(to, name), r = rel ? `${rel}/${name}` : name, st = lstatSync(a);
      if (st.isSymbolicLink()) { const t = readlinkSync(a), why = symlinkProblem(r, t); if (why) throw new Error(`checkout contains a symlink that is not allowed (${r}): ${why}`); symlinkSync(t, b); }
      else if (st.isDirectory()) walk(a, b, r);
      else if (st.isFile()) { copyFileSync(a, b); chmodSync(b, modeOf(st) === "100755" ? 0o755 : 0o644); }
      else throw new Error(`special file ${r} cannot be copied`);
    }
  };
  walk(src, dst, "");
}

/** Does any directory above `rel` inside `root` turn out to be a symlink? Writing through one is refused. */
export function passesThroughLink(root: string, rel: string): boolean {
  const parts = rel.split("/").slice(0, -1); let cur = root;
  for (const p of parts) { cur = join(cur, p); try { if (lstatSync(cur).isSymbolicLink()) return true; } catch { return false; } }
  return false;
}

/** Paths a candidate changes, text and non-text, in sorted order. */
export function changedPaths(c: Pick<CandidateRecord, "contents" | "entries">): string[] { return [...new Set([...Object.keys(c.contents ?? {}), ...Object.keys(c.entries ?? {})])].sort(); }

/** Write the candidate's changes into `dir` (a copy of its base): removals first, then every file, mode and link. */
export function applyCandidateToDir(dir: string, c: Pick<CandidateRecord, "contents" | "entries" | "mutations">): void {
  const paths = changedPaths(c); const contents = c.contents ?? {}, entries = c.entries ?? {};
  const gone = (p: string) => (p in entries ? entries[p] === null : contents[p] === null);
  for (const p of paths) if (gone(p)) rmSync(safeJoin(dir, p), { force: true });
  // a path that moved away because of a rename is in the inventory, not in `contents`; old paths are removed here too
  for (const m of c.mutations) if (m.oldPath && (m.kind === "DELETED" || m.kind === "RENAMED")) rmSync(safeJoin(dir, m.oldPath), { force: true });
  for (const p of paths) {
    if (gone(p)) continue;
    const abs = safeJoin(dir, p); if (passesThroughLink(dir, p)) throw new Error(`${p} would be written through a symlink`);
    mkdirSync(dirname(abs), { recursive: true }); rmSync(abs, { force: true });
    const e = entries[p];
    if (e?.kind === "SYMLINK") { const why = symlinkProblem(p, e.target ?? ""); if (why) throw new Error(`${p}: ${why}`); symlinkSync(e.target!, abs); }
    else if (e?.kind === "BINARY") { writeFileSync(abs, Buffer.from(e.base64 ?? "", "base64")); chmodSync(abs, e.mode === "100755" ? 0o755 : 0o644); }
    else { writeFileSync(abs, contents[p] ?? ""); chmodSync(abs, (e?.mode ?? "100644") === "100755" ? 0o755 : 0o644); }
  }
}
