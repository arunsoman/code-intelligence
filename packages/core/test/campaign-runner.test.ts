// F08 real execution adapters, exercised against scratch repositories (no forge, no network). These are the pieces the
// service wires when `campaigns.enabled`: the isolated recipe runner (WP-04), the isolated validator and the npm
// local-link joint runner (WP-07). They complement the deterministic engine tests in campaigns.test.ts.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChildArtifact, JointCheckRequest } from "../src/campaigns.ts";
import { JointRunner, RecipeRunner, globToRe, pushCandidateBranch, validateCandidate } from "../src/campaign-runner.ts";
import { copyTree, makeScratch, removeScratch } from "../src/isolated-exec.ts";
function write(root: string, rel: string, text: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
function scratch(files: Record<string, string>): string {
  const root = makeScratch("cie-fixture-");
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  return root;
}
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");

const recipe = (args: Record<string, unknown>) => ({ kind: "RECIPE" as const, recipeId: "r", recipeVersion: "1", args });

describe("F08 glob matching", () => {
  test("matches selectors the way the recipe language means them", () => {
    assert.ok(globToRe("src/**/*.ts").test("src/a/b/c.ts"));
    assert.ok(globToRe("src/*.ts").test("src/a.ts"));
    assert.ok(!globToRe("src/*.ts").test("src/a/b.ts"));
    assert.ok(globToRe("*.{ts,tsx}").test("deep/a.tsx"));
    assert.ok(!globToRe("src/a.ts").test("src/b.ts"));
  });
});

describe("F08 recipe runner (WP-04)", () => {
  test("applies a deterministic rewrite in an isolated copy and leaves the repository untouched", () => {
    const repo = scratch({
      "package.json": JSON.stringify({ name: "consumer", version: "1.0.0" }),
      "src/a.ts": "export const create = (ctx: string, amount: number) => amount;\n",
      "src/b.ts": "export const other = 1;\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    });
    try {
      const runner = new RecipeRunner();
      const t = recipe({ selectors: ["src/a.ts"], rewrites: [{ file: "src/a.ts", find: "amount: number", replace: "amount: { value: number }" }] });
      assert.equal(runner.transformationApplies(repo, t).applies, true);
      const first = runner.applyRecipe(repo, "base", t);
      assert.ok(first.ok, "the recipe applied");
      assert.deepEqual(first.files, ["src/a.ts"]);
      assert.equal(first.forbiddenPaths.length, 0);
      const second = runner.applyRecipe(repo, "base", t);
      assert.ok(second.ok && first.ok);
      assert.equal(second.diffHash, first.diffHash, "same base + same recipe → same diff hash");
      assert.match(read(repo, "src/a.ts"), /amount: number/, "the repository itself was never written");
      assert.match(readFileSync(join(first.dir!, "src/a.ts"), "utf8"), /amount: \{ value: number \}/, "the candidate tree carries the change");
    } finally { removeScratch(repo); }
  });

  test("refuses a recipe that touches a protected path (F08-D3)", () => {
    const repo = scratch({ ".github/workflows/ci.yml": "name: ci\n", "src/a.ts": "export const a = 1;\n" });
    try {
      const runner = new RecipeRunner();
      const r = runner.applyRecipe(repo, "base", recipe({ rewrites: [{ file: ".github/workflows/ci.yml", find: "name: ci", replace: "name: ci2" }] }));
      assert.ok(r.ok);
      assert.deepEqual(r.forbiddenPaths, [".github/workflows/ci.yml"]);
    } finally { removeScratch(repo); }
  });

  test("refuses a change outside the recipe's declared selectors (containment)", () => {
    const repo = scratch({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
    try {
      const runner = new RecipeRunner();
      const r = runner.applyRecipe(repo, "base", recipe({ selectors: ["src/a.ts"], rewrites: [{ file: "src/b.ts", find: "= 2", replace: "= 3" }] }));
      assert.ok(r.ok);
      assert.deepEqual(r.forbiddenPaths, ["src/b.ts"], "a transformation may only touch what it declares");
    } finally { removeScratch(repo); }
  });

  test("reports a selector miss as 'does not apply' rather than success", () => {
    const repo = scratch({ "src/a.ts": "export const a = 1;\n" });
    try {
      const runner = new RecipeRunner();
      const t = recipe({ selectors: ["src/missing.ts"], rewrites: [{ file: "src/missing.ts", find: "x", replace: "y" }] });
      assert.equal(runner.transformationApplies(repo, t).applies, false);
    } finally { removeScratch(repo); }
  });

  test("runs the recipe against the child's pinned base commit, not the working tree", () => {
    const work = makeScratch("cie-work-");
    const git = (args: string[]) => spawnSync("git", ["-C", work, ...args], { encoding: "utf8", timeout: 60_000 });
    try {
      assert.equal(git(["init", "--quiet", "-b", "main"]).status, 0);
      write(work, "src/a.ts", "export const a = 1;\n");
      git(["add", "-A"]);
      assert.equal(git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "one"]).status, 0);
      const first = git(["rev-parse", "HEAD"]).stdout!.trim();
      write(work, "src/a.ts", "export const a = 1;\nexport const b = 2;\n");
      git(["add", "-A"]);
      assert.equal(git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "two"]).status, 0);
      const r = new RecipeRunner().applyRecipe(work, first, recipe({ selectors: ["src/a.ts"], rewrites: [{ file: "src/a.ts", find: "a = 1", replace: "a = 9" }] }));
      assert.ok(r.ok);
      const cand = readFileSync(join(r.dir!, "src/a.ts"), "utf8");
      assert.match(cand, /a = 9/);
      assert.doesNotMatch(cand, /b = 2/, "the later commit is not part of the pinned base");
    } finally { removeScratch(work); }
  });
});

describe("F08 isolated validator (WP-04)", () => {
  test("passes a clean candidate, fails a candidate that introduces a type error, and never trusts an untrusted checkout's tests", () => {
    const repo = scratch({
      "src/a.ts": "export const create = (ctx: string, amount: number) => amount;\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    });
    try {
      const runner = new RecipeRunner();
      const clean = runner.applyRecipe(repo, "base", recipe({ selectors: ["src/a.ts"], rewrites: [{ file: "src/a.ts", find: "amount: number", replace: "amount: { value: number }" }] }));
      assert.ok(clean.ok);
      const artifact = (r: typeof clean): ChildArtifact => ({ repositoryId: "r", baseCommit: "base", headHash: r.headHash!, diffHash: r.diffHash, files: r.files, dir: r.dir, baseDir: r.baseDir });
      const ok = validateCandidate({ candidate: artifact(clean), trusted: false });
      assert.equal(ok.state, "PASSED");
      assert.match(ok.reason ?? "", /compile check only/);

      const broken = runner.applyRecipe(repo, "base", recipe({ selectors: ["src/a.ts"], rewrites: [{ file: "src/a.ts", find: "amount: number", replace: "amount: number = ;" }] }));
      assert.ok(broken.ok);
      const bad = validateCandidate({ candidate: artifact(broken), trusted: false });
      assert.equal(bad.state, "FAILED");
      assert.match(bad.reason ?? "", /compile error/);
    } finally { removeScratch(repo); }
  });
});

describe("F08 joint runner (WP-07)", () => {
  const producerFiles = (signature: string) => ({
    "package.json": JSON.stringify({ name: "@acme/lib", version: "1.0.0", type: "module", main: "index.js" }),
    "index.js": signature,
  });
  const consumerFiles = {
    "package.json": JSON.stringify({ name: "consumer", version: "1.0.0", type: "module", dependencies: { "@acme/lib": "1.0.0" } }),
    "app.test.js": "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { greet } from \"@acme/lib\";\ntest(\"greet\", () => assert.equal(greet(\"x\"), \"hi x\"));\n",
  };

  const artifacts = (repo: string, baseDir: string, candDir: string): ChildArtifact => ({ repositoryId: repo, baseCommit: "base", headHash: "h", diffHash: "d", files: [], dir: candDir, baseDir });

  test("links a matching producer and consumer and passes", () => {
    const base = scratch(producerFiles("export const greet = (name) => `hi ${name}`;\n"));
    const cand = makeScratch("cie-cand-"); copyTree(base, cand);
    const consumer = scratch(consumerFiles);
    const consumerCand = makeScratch("cie-cand-"); copyTree(consumer, consumerCand);
    try {
      const req: JointCheckRequest = { campaignId: "c", caseId: "case-1", producerRepository: "producer", consumerRepository: "consumer", mode: "CANDIDATE_WITH_CANDIDATE", transformation: recipe({}), producer: artifacts("producer", base, cand), consumer: artifacts("consumer", consumer, consumerCand) };
      const outcome = new JointRunner().check(req);
      assert.equal(outcome.state, "PASSED");
      assert.ok("manifest" in outcome && outcome.manifest);
      assert.equal(outcome.manifest!.linkMethod, "npm-workspace-symlink");
    } finally { for (const d of [base, cand, consumer, consumerCand]) removeScratch(d); }
  });

  test("fails when the producer changes its signature and the consumer is not updated", () => {
    const base = scratch(producerFiles("export const greet = (name) => `hi ${name}`;\n"));
    const cand = makeScratch("cie-cand-"); copyTree(base, cand);
    write(cand, "index.js", "export const greet = (name, opts) => `hi ${name}${opts.punct}`;\n");
    const consumer = scratch(consumerFiles);
    const consumerCand = makeScratch("cie-cand-"); copyTree(consumer, consumerCand);
    try {
      const req: JointCheckRequest = { campaignId: "c", caseId: "case-2", producerRepository: "producer", consumerRepository: "consumer", mode: "CANDIDATE_WITH_CANDIDATE", transformation: recipe({}), producer: artifacts("producer", base, cand), consumer: artifacts("consumer", consumer, consumerCand) };
      const outcome = new JointRunner().check(req);
      assert.equal(outcome.state, "FAILED");
      assert.ok(outcome.state === "FAILED" && /opts|test|fail|Cannot/i.test(outcome.reason ?? ""));
    } finally { for (const d of [base, cand, consumer, consumerCand]) removeScratch(d); }
  });

  test("says NOT_EVALUABLE when there is no npm linker to apply", () => {
    const producer = scratch({ "go.mod": "module example.com/lib\n" });
    const consumer = scratch({ "go.mod": "module example.com/app\n" });
    try {
      const req: JointCheckRequest = { campaignId: "c", caseId: "case-3", producerRepository: "p", consumerRepository: "c", mode: "CANDIDATE_WITH_CANDIDATE", transformation: recipe({}), producer: artifacts("p", producer, producer), consumer: artifacts("c", consumer, consumer) };
      const outcome = new JointRunner().check(req);
      assert.equal(outcome.state, "NOT_EVALUABLE");
    } finally { for (const d of [producer, consumer]) removeScratch(d); }
  });
});

describe("F08 publisher branch push (WP-09)", () => {
  test("pushes the candidate tree to a branch on the origin without touching the working checkout", () => {
    const bare = makeScratch("cie-bare-");
    const work = makeScratch("cie-work-");
    const cand = makeScratch("cie-cand-");
    const git = (args: string[], cwd: string) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 60_000 });
    try {
      assert.equal(git(["init", "--bare", "--quiet"], bare).status, 0);
      assert.equal(git(["init", "--quiet", "-b", "main"], work).status, 0);
      write(work, "src/a.ts", "export const a = 1;\n");
      git(["add", "-A"], work);
      assert.equal(git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], work).status, 0);
      git(["remote", "add", "origin", bare], work);
      assert.equal(git(["push", "--quiet", "-u", "origin", "main"], work).status, 0);
      copyTree(work, cand);
      write(cand, "src/a.ts", "export const a = 2;\n");
      const r = pushCandidateBranch({ repoRoot: work, baseCommit: "HEAD", candidateDir: cand, branch: "cie/campaign-x", title: "campaign" });
      assert.ok(r.ok, r.ok ? "" : r.reason);
      const head = git(["rev-parse", "refs/heads/cie/campaign-x"], bare).stdout?.trim();
      assert.ok(head && head.length === 40, "the branch exists on the origin");
      assert.match(git(["show", "cie/campaign-x:src/a.ts"], bare).stdout ?? "", /= 2/);
      assert.match(read(work, "src/a.ts"), /= 1/, "the working checkout is untouched");
    } finally { for (const d of [bare, work, cand]) removeScratch(d); }
  });
});
