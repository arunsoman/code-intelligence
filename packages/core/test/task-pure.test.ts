// F07 presentation-free rules: the edit-operation admission boundary, exactness, the syntactic oracle-preservation
// detector, binding identity, and the source-snippet egress preview. These run without a repository, a model or a
// runner, so each rule is checked on its own before any run happens.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { admissionProblems, bindingHashOf, detectOracleWeakening, exactnessProblems, extractAssertions, isProtectedPath, normalizeRel, proposalSpans, type EditContext } from "../src/execution.ts";
import { sha256 } from "../src/isolated-exec.ts";

const ctx = (over: Partial<EditContext> = {}): EditContext => ({ allowedPaths: ["src", "tests"], forbiddenPaths: [], maxFilesChanged: 5, maxDiffLines: 200, ...over });
const span = (file: string, hash: string, expected: string) => ({ op: "REPLACE_SPAN" as const, file, baseHash: hash, start: 0, end: expected.length, expected, newText: "x", why: "w" });

describe("F07 admission (D1)", () => {
  test("traversal, absolute paths and .git are rejected, never normalised away", () => {
    const h = sha256("x");
    const problems = admissionProblems([span("../outside.ts", h, "x"), span("/etc/passwd", h, "x"), span(".git/config", h, "x")], ctx({ allowedPaths: [] }));
    assert.ok(problems.some((p) => /traversal/.test(p)), problems.join("; "));
    assert.ok(problems.some((p) => /absolute/.test(p)), problems.join("; "));
    assert.ok(problems.some((p) => /\.git/.test(p)), problems.join("; "));
  });

  test("protected paths (CI config, lockfile, secrets, tests) are refused unless the task authorises them", () => {
    const h = sha256("x");
    const ci = admissionProblems([span(".github/workflows/ci.yml", h, "x")], ctx({ allowedPaths: [] }));
    assert.ok(ci.some((p) => /protected path/.test(p)), ci.join("; "));
    assert.ok(isProtectedPath("package-lock.json") && isProtectedPath("src/secrets/keys.ts".replace("src/", "")) && isProtectedPath("tests/a.test.ts"));
    assert.ok(!isProtectedPath("src/index.ts"));
    const allowed = admissionProblems([span("tests/a.test.ts", h, "x")], ctx({ allowTestEdits: true }));
    assert.deepEqual(allowed, []);
  });

  test("size caps and overlapping spans are refused, not truncated", () => {
    const h = sha256("x");
    const a = span("src/a.ts", h, "abcd");
    const b = { ...span("src/a.ts", h, "efgh"), start: 2, end: 6 };
    const overlap = admissionProblems([a, b], ctx());
    assert.ok(overlap.some((p) => /overlapping/.test(p)), overlap.join("; "));
    const big = admissionProblems([{ ...span("src/a.ts", h, "a"), newText: "b\n".repeat(50) }], ctx({ maxDiffLines: 10 }));
    assert.ok(big.some((p) => /maxDiffLines/.test(p)), big.join("; "));
  });

  test("relative paths are normalised without escaping the repository", () => {
    assert.strictEqual(normalizeRel("./src/./a.ts"), "src/a.ts");
    assert.strictEqual(normalizeRel("src\\a.ts"), "src/a.ts");
  });
});

describe("F07 exactness (A1)", () => {
  const file = "value = 1;\n";

  test("an edit whose quoted bytes or base hash do not match is rejected as STALE, never applied", () => {
    const root = mkdtempSync(join(tmpdir(), "f07-pure-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), file);
    const good = { op: "REPLACE_SPAN" as const, file: "src/a.ts", baseHash: sha256(file), start: 8, end: 9, expected: "1", newText: "2", why: "w" };
    assert.deepEqual(exactnessProblems(root, [good]), []);
    assert.ok(exactnessProblems(root, [{ ...good, expected: "9" }]).some((p) => /not what the edit quotes/.test(p)));
    assert.ok(exactnessProblems(root, [{ ...good, baseHash: sha256("other") }]).some((p) => /base hash mismatch/.test(p)));
    assert.ok(exactnessProblems(root, [{ op: "CREATE_FILE", file: "src/a.ts", content: "x", why: "w" }]).some((p) => /already exists/.test(p)));
    assert.ok(exactnessProblems(root, [{ op: "DELETE_FILE", file: "src/missing.ts", baseHash: sha256("x"), why: "w" }]).some((p) => /does not exist/.test(p)));
  });
});

describe("F07 oracle preservation (A2)", () => {
  const base = new Map([["tests/a.test.ts", [
    'test("adds", () => { expect(add(1, 2)).toBe(3); });',
    'test("subtracts", () => { expect(sub(3, 1)).toBe(2); });',
    'test("snapshots", () => { expect(render()).toMatchSnapshot(); });',
  ].join("\n")]]);

  const changesFor = (candidate: string) => detectOracleWeakening(base, new Map([["tests/a.test.ts", candidate]]));

  test("a deleted test case, a deleted test file and a swallowed error are each detected", () => {
    assert.ok(changesFor('test("adds", () => { expect(add(1, 2)).toBe(3); });').some((c) => c.kind === "REMOVED_TEST_CASE"));
    assert.ok(detectOracleWeakening(base, new Map()).some((c) => c.kind === "DELETED_TEST_FILE"));
    assert.ok(changesFor('test("adds", () => { try { expect(add(1, 2)).toBe(3); } catch {} });\ntest("subtracts", () => { expect(sub(3, 1)).toBe(2); });\ntest("snapshots", () => { expect(render()).toMatchSnapshot(); });').some((c) => c.kind === "SWALLOWED_ERROR"));
  });

  test("a changed expected value and a loosened matcher are distinguished", () => {
    const changed = changesFor('test("adds", () => { expect(add(1, 2)).toBe(4); });\ntest("subtracts", () => { expect(sub(3, 1)).toBe(2); });\ntest("snapshots", () => { expect(render()).toMatchSnapshot(); });');
    assert.ok(changed.some((c) => c.kind === "CHANGED_EXPECTED"), JSON.stringify(changed));
    const loosened = changesFor('test("adds", () => { expect(add(1, 2)).toBeDefined(); });\ntest("subtracts", () => { expect(sub(3, 1)).toBe(2); });\ntest("snapshots", () => { expect(render()).toMatchSnapshot(); });');
    assert.ok(loosened.some((c) => c.kind === "LOOSENED_MATCHER"), JSON.stringify(loosened));
  });

  test("skip/only, a raised timeout and a rewritten snapshot are each detected", () => {
    assert.ok(changesFor('test.skip("adds", () => {});\ntest("subtracts", () => { expect(sub(3, 1)).toBe(2); });\ntest("snapshots", () => { expect(render()).toMatchSnapshot(); });').some((c) => c.kind === "ADDED_SKIP"));
    assert.ok(changesFor('test.only("adds", () => { expect(add(1, 2)).toBe(3); });\ntest("subtracts", () => { expect(sub(3, 1)).toBe(2); });\ntest("snapshots", () => { expect(render()).toMatchSnapshot(); });').some((c) => c.kind === "ADDED_ONLY"));
    assert.ok(changesFor('test("adds", () => { expect(add(1, 2)).toBe(3); }, 60_000);\ntest("subtracts", () => { expect(sub(3, 1)).toBe(2); });\ntest("snapshots", () => { expect(render()).toMatchSnapshot(); });').some((c) => c.kind === "RAISED_TIMEOUT"));
    assert.ok(changesFor('test("adds", () => { expect(add(1, 2)).toBe(3); });\ntest("subtracts", () => { expect(sub(3, 1)).toBe(2); });').some((c) => c.kind === "SNAPSHOT_REWRITE"));
  });

  test("an unchanged file reports nothing, and extraction is scoped to its test case", () => {
    assert.deepEqual(detectOracleWeakening(base, new Map(base)), []);
    const facts = extractAssertions("tests/a.test.ts", 'test("adds", () => { expect(add(1, 2)).toBe(3); });');
    assert.deepEqual(facts, [{ file: "tests/a.test.ts", testCase: "adds", matcher: "toBe", value: "3" }]);
  });
});

describe("F07 binding identity", () => {
  test("the binding hash is stable across key order and changes when any quoted hash changes", () => {
    const core = { baseContentHash: sha256("base"), candidateContentHash: sha256("cand"), diffHash: sha256("diff") };
    assert.strictEqual(bindingHashOf(core), bindingHashOf({ diffHash: core.diffHash, candidateContentHash: core.candidateContentHash, baseContentHash: core.baseContentHash }));
    assert.notStrictEqual(bindingHashOf(core), bindingHashOf({ ...core, diffHash: sha256("diff2") }));
  });
});

describe("F07 source-snippet egress (D4/D5)", () => {
  const root = mkdtempSync(join(tmpdir(), "f07-egress-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const safe = "const answer = compute(41);\n";
  const secret = 'const apiKey = "sk-live-abcdefghijklmnop";\n';
  writeFileSync(join(root, "src", "safe.ts"), safe);
  writeFileSync(join(root, "src", "secret.ts"), secret);

  test("without consent the payload carries paths, ranges and hashes but no text at all", () => {
    const out = proposalSpans(root, [{ file: "src/safe.ts", start: 0, end: safe.length }], { sourceSnippetsConsent: false });
    assert.strictEqual(out.text, undefined);
    assert.strictEqual(out.preview.length, 1);
    assert.strictEqual(out.preview[0]!.hash, sha256(safe));
    assert.strictEqual(out.preview[0]!.bytes, safe.length);
  });

  test("with consent only the previewed spans travel, and a span holding a secret value is withheld", () => {
    const out = proposalSpans(root, [{ file: "src/safe.ts", start: 0, end: safe.length }, { file: "src/secret.ts", start: 0, end: secret.length }], { sourceSnippetsConsent: true });
    assert.deepEqual(out.text?.map((t) => t.file), ["src/safe.ts"]);
    assert.ok(out.withheld.some((w) => w.file === "src/secret.ts" && /secret/.test(w.reason)));
  });
});

describe("F07 draft publisher over a scripted gh (D7/D8)", () => {
  test("the only write is a draft create-pull-request, verified: a non-draft receipt is refused", async () => {
    const { GhDraftForge } = await import("../src/gh-forge.ts");
    const calls: string[][] = [];
    const forge = new GhDraftForge({
      run: (args) => {
        calls.push(args);
        if (args.includes("GET") && args.some((a) => a.endsWith("/pulls"))) return { status: 0, stdout: "[]", stderr: "" };
        if (args.includes("POST")) return { status: 0, stdout: JSON.stringify({ number: 7, html_url: "https://x/7", draft: false, head: { sha: "h1" } }), stderr: "" };
        return { status: 0, stdout: JSON.stringify({ object: { sha: "b1" } }), stderr: "" };
      },
    });
    await assert.rejects(() => forge.createDraft({ repository: "o/r", baseBranch: "main", headBranch: "cie/x", headHash: "h1" }, "## Title"), /not a draft/);
    assert.ok(calls.some((c) => c.includes("draft=true")), "the create call must ask for a draft");
    assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "merge"), "there is no merge call anywhere");
  });

  test("a resumed publication adopts the PR found by head instead of creating a second", async () => {
    const { GhDraftForge } = await import("../src/gh-forge.ts");
    const calls: string[][] = [];
    const forge = new GhDraftForge({
      run: (args) => {
        calls.push(args);
        if (args.some((a) => a.endsWith("/pulls"))) return { status: 0, stdout: JSON.stringify([{ number: 3, html_url: "https://x/3", draft: true, head: { sha: "h1" } }]), stderr: "" };
        return { status: 0, stdout: JSON.stringify({ object: { sha: "b1" } }), stderr: "" };
      },
    });
    const found = await forge.find({ repository: "o/r", headBranch: "cie/x" });
    assert.deepStrictEqual(found, { number: 3, url: "https://x/3", headHash: "h1", draft: true });
    assert.ok(!calls.some((c) => c.includes("POST")), "finding a PR must not create one");
  });

  test("a rate limit, an expired credential and a refusal map to their connector states", async () => {
    const { GhDraftForge, GhError } = await import("../src/gh-forge.ts");
    const fail = (stderr: string) => new GhDraftForge({ run: () => ({ status: 1, stdout: "", stderr }) });
    await assert.rejects(() => fail("API rate limit exceeded").resolve("o/r", "main", "cie/x"), (e: unknown) => e instanceof GhError && e.state === "RATE_LIMITED");
    await assert.rejects(() => fail("HTTP 401: Bad credentials").resolve("o/r", "main", "cie/x"), (e: unknown) => e instanceof GhError && e.state === "EXPIRED");
    await assert.rejects(() => fail("HTTP 403: refusing to allow a Personal Access Token").resolve("o/r", "main", "cie/x"), (e: unknown) => e instanceof GhError && e.state === "REFUSED");
    // A missing head branch is not an error: it is the ordinary "does not exist yet" answer.
    const missing = new GhDraftForge({ run: (args) => (args[1]?.includes("heads/cie/") ? { status: 1, stdout: "", stderr: "HTTP 404: Not Found" } : { status: 0, stdout: JSON.stringify({ object: { sha: "b1" } }), stderr: "" }) });
    assert.deepStrictEqual(await missing.resolve("o/r", "main", "cie/x"), { baseHash: "b1", headHash: null });
  });
});
