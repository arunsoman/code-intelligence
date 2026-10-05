import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { asSet, canonDecimal, canonDigest, canonicalize, CanonError, contentRoot, defineSchema, entriesFromDirectory, parseStrictJson, rawHash, type Canon, type ManifestEntry } from "../src/feature/canon.ts";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILE = resolve(import.meta.dirname, "../../../fixtures/canon/canon-vectors.json");
const doc = JSON.parse(readFileSync(FILE, "utf8")) as { protocol: string; vectors: any[]; relations: { same?: string[]; different?: string[] }[] };

/** `{"$set":[...]}` marks a schema-designated set; the vector file has no other way to say it. */
const revive = (v: Canon): Canon => {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === "object") {
    const o = v as Record<string, Canon>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === "$set") return asSet((o.$set as Canon[]).map(revive));
    return Object.fromEntries(keys.map((k) => [k, revive(o[k])]));
  }
  return v;
};
const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof CanonError ? e.code : `OTHER:${(e as Error).message}`; } };

const digests = new Map<string, string>();
for (const v of doc.vectors) {
  test(`pf-canon-v1 vector ${v.id}`, () => {
    if (v.op === "hash" || v.op === "reject") {
      const run = () => {
        const input = v.inputHex !== undefined ? Buffer.from(v.inputHex, "hex") : (v.inputText as string);
        let value = revive(parseStrictJson(input));
        if (v.project) { const o = value as Record<string, Canon>; value = Object.fromEntries((v.project as string[]).filter((k) => k in o).map((k) => [k, o[k]])); }
        return { text: canonicalize(value) };
      };
      if (v.op === "reject") return assert.equal(code(run), v.expectError);
      const { text } = run();
      assert.equal(text, v.expectedCanonical);
      const d = canonDigest(v.schema, v.version, text);
      assert.equal(d, v.expectedDigest);
      digests.set(v.id, d);
    } else if (v.op === "decimal") {
      if (v.expectError) assert.equal(code(() => canonDecimal(v.input)), v.expectError);
      else assert.equal(canonDecimal(v.input), v.expected);
    } else if (v.op === "raw") {
      const d = rawHash(Buffer.from(v.inputHex, "hex")); assert.equal(d, v.expectedDigest); digests.set(v.id, d);
    } else if (v.op === "root") {
      if (v.expectError) return assert.equal(code(() => contentRoot(v.entries as ManifestEntry[])), v.expectError);
      const r = contentRoot(v.entries as ManifestEntry[]);
      assert.equal(r, `pf-canon-v1/pf.contentRoot@1:${v.expectedDigest}`); digests.set(v.id, v.expectedDigest);
    } else assert.fail(`unknown op ${v.op}`);
  });
}

test("pf-canon-v1 relations: the same/different claims hold for the computed digests", () => {
  assert.equal(doc.protocol, "pf-canon-v1");
  for (const r of doc.relations) {
    const ds = (r.same ?? r.different!).map((id) => digests.get(id));
    assert.ok(ds.every((d) => d), `a related vector did not run: ${JSON.stringify(r)}`);
    if (r.same) assert.ok(ds.every((d) => d === ds[0]), `expected same: ${r.same}`);
    else assert.notEqual(ds[0], ds[1], `expected different: ${r.different}`);
  }
});

test("canonicalize rejects values outside the protocol when built in code, not only when parsed", () => {
  assert.equal(code(() => canonicalize(1.5 as any)), "UNSAFE_NUMBER");
  assert.equal(code(() => canonicalize(NaN as any)), "UNSAFE_NUMBER");
  assert.equal(code(() => canonicalize(Infinity as any)), "UNSAFE_NUMBER");
  assert.equal(code(() => canonicalize(-0 as any)), "NEGATIVE_ZERO");
  assert.equal(code(() => canonicalize(undefined as any)), "UNSUPPORTED_VALUE");
  assert.equal(code(() => canonicalize({ a: undefined } as any)), "UNSUPPORTED_VALUE");
  assert.equal(code(() => canonicalize(10n as any)), "UNSUPPORTED_VALUE");
  assert.equal(code(() => canonicalize(new Date() as any)), "UNSUPPORTED_VALUE");
  assert.equal(code(() => canonicalize("\ud800")), "BAD_STRING");
  assert.equal(code(() => canonicalize({ "é": 1 })), "BAD_KEY");
});

test("canonHash is stable under key reordering for any generated payload", () => {
  const schema = defineSchema<Record<string, Canon>>("t.prop", "1", (p) => p);
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let n = 0; n < 200; n++) {
    const keys = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => "k" + i);
    const obj: Record<string, Canon> = {}; for (const k of keys) obj[k] = rnd() < 0.5 ? Math.floor(rnd() * 1000) : "v" + Math.floor(rnd() * 1000);
    const shuffled = Object.fromEntries([...keys].sort(() => rnd() - 0.5).map((k) => [k, obj[k]]));
    assert.equal(canonicalize(obj), canonicalize(shuffled));
  }
});

test("stored identity names its protocol and schema; the digest matches an independent computation", () => {
  const schema = defineSchema<{ a: number }>("t.one", "1", (p) => ({ a: p.a }));
  const expected = createHash("sha256").update(Buffer.concat([Buffer.from("pf-canon-v1\0t.one\x001\0", "utf8"), Buffer.from('{"a":1}')])).digest("hex");
  assert.equal(canonDigest("t.one", "1", '{"a":1}'), expected);
  assert.match(String(defineSchema("t.one", "1", () => null).name), /^t\.one$/);
  void schema;
});

test("a directory walk records symlinks without following them and refuses to exclude source", () => {
  const dir = mkdtempSync(join(tmpdir(), "canon-"));
  try {
    mkdirSync(join(dir, "src")); writeFileSync(join(dir, "src", "a.ts"), "export {}\n"); symlinkSync("../../outside", join(dir, "src", "link"));
    const entries = entriesFromDirectory(dir);
    assert.deepEqual(entries.map((e) => [e.path, e.kind]).sort(), [["src/a.ts", "file"], ["src/link", "symlink"]]);
    assert.equal(code(() => entriesFromDirectory(dir, { exclude: ["src"] })), "BAD_EXCLUSION");
    const a = contentRoot(entries); writeFileSync(join(dir, "src", "a.ts"), "export {}\r\n");
    assert.notEqual(contentRoot(entriesFromDirectory(dir)), a, "a newline change in raw code changes identity");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
