// F04-D1: published comparator vectors per ecosystem, plus ordering-law property tests (reflexivity, antisymmetry,
// transitivity) over generated version lists. An unparseable version throws — the caller maps that to `applies: UNKNOWN`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { comparatorFor, VersionError } from "../src/deps/versions.ts";

const cmp = (eco: "npm" | "cargo" | "golang" | "pypi" | "maven", a: string, b: string) => Math.sign(comparatorFor(eco).compare(a, b));

/** Assert the given versions are in strictly increasing order. */
function chain(eco: "npm" | "cargo" | "golang" | "pypi" | "maven", ordered: string[]) {
  for (let i = 0; i < ordered.length; i++) {
    assert.equal(cmp(eco, ordered[i], ordered[i]), 0, `${eco} ${ordered[i]} == itself`);
    for (let j = i + 1; j < ordered.length; j++) {
      assert.equal(cmp(eco, ordered[i], ordered[j]), -1, `${eco}: ${ordered[i]} < ${ordered[j]}`);
      assert.equal(cmp(eco, ordered[j], ordered[i]), 1, `${eco}: antisymmetry ${ordered[j]} > ${ordered[i]}`);
    }
  }
}

test("npm semver: pre-release ordering (semver.org vector), build metadata ignored", () => {
  chain("npm", [
    "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0",
  ]);
  assert.equal(cmp("npm", "1.0.0+build1", "1.0.0+build2"), 0, "build metadata does not affect precedence");
  chain("npm", ["0.9.9", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"]);
});

test("npm range grammar: caret, tilde, x-ranges, comparators, hyphen, alternation, pre-release rule", () => {
  const sat = (v: string, r: string) => comparatorFor("npm").satisfies(v, r);
  assert.ok(sat("1.2.3", "^1.2.3") && sat("1.9.0", "^1.2.3") && !sat("2.0.0", "^1.2.3"));
  assert.ok(sat("0.2.3", "^0.2.3") && !sat("0.3.0", "^0.2.3"), "0.x caret stays in the minor series");
  assert.ok(sat("0.0.3", "^0.0.3") && !sat("0.0.4", "^0.0.3"), "^0.0.x stays on the patch");
  assert.ok(sat("1.2.9", "~1.2.3") && !sat("1.3.0", "~1.2.3"));
  assert.ok(sat("1.5.0", "1.x") && !sat("2.0.0", "1.x"));
  assert.ok(sat("1.2.3", ">=1.0.0 <2.0.0") && !sat("2.0.0", ">=1.0.0 <2.0.0"));
  assert.ok(sat("1.2.3", "1.0.0 - 2.0.0") && sat("2.0.0", "1.0.0 - 2.0.0") && !sat("2.0.1", "1.0.0 - 2.0.0"));
  assert.ok(sat("1.2.3", "^1.0.0 || ^2.0.0") && sat("2.1.0", "^1.0.0 || ^2.0.0"));
  // pre-release rule: a pre-release only matches a comparator naming a pre-release on the same base version
  assert.ok(!sat("1.2.3-alpha.1", "^1.2.3"), "a prerelease does not satisfy a release range");
  assert.ok(sat("1.2.3-beta.1", ">=1.2.3-alpha <2.0.0"), "but does satisfy a prerelease comparator on the same base");
  assert.ok(sat("1.2.3", "*") && sat("9.9.9", "*"));
});

test("cargo: caret is the default; exact with =; pre-release rule", () => {
  const sat = (v: string, r: string) => comparatorFor("cargo").satisfies(v, r);
  assert.ok(sat("1.4.0", "1.2") && !sat("2.0.0", "1.2"), "bare 1.2 means ^1.2");
  assert.ok(sat("0.1.5", "0.1") && !sat("0.2.0", "0.1"), "bare 0.1 means ^0.1");
  assert.ok(sat("1.2.3", "1.2.3") && sat("1.9.0", "1.2.3") && !sat("2.0.0", "1.2.3"), "bare 1.2.3 is caret, not exact");
  assert.ok(sat("1.2.3", "=1.2.3") && !sat("1.2.4", "=1.2.3"));
  assert.ok(sat("1.4.0", ">=1.2, <1.5") && !sat("1.5.0", ">=1.2, <1.5"));
  assert.ok(sat("1.0.0-alpha.2", "1.0.0-alpha") && sat("1.0.0-beta", "1.0.0-alpha"), "cargo prerelease: same base, ordered pre");
  assert.ok(!sat("1.0.0-alpha", "1.0.0"), "a prerelease does not satisfy a release requirement");
  chain("cargo", ["0.9.0", "1.0.0-alpha", "1.0.0", "1.0.1"]);
});

test("go: v-prefix required, pseudo-versions order by timestamp within a base", () => {
  const c = comparatorFor("golang");
  assert.ok(!c.valid("1.2.3"), "go versions carry the v prefix");
  assert.ok(c.valid("v1.2.3") && c.valid("v0.0.0-20200101000000-abcdef123456") && c.valid("v2.0.0+incompatible"));
  chain("golang", [
    "v0.0.0-20200101000000-aaaaaaaaaaaa", "v0.0.0-20210101000000-bbbbbbbbbbbb", "v0.17.0", "v1.0.0-rc.1", "v1.0.0", "v1.0.1",
  ]);
  assert.ok(c.satisfies("v1.2.3", "v1.2.3") && !c.satisfies("v1.2.4", "v1.2.3"), "go admission is exact (MVS picks the minimum)");
  assert.throws(() => c.compare("1.2.3", "v1.2.3"), VersionError);
});

test("pypi PEP 440: dev < pre < release < post, epochs dominate, local ignored for precedence", () => {
  chain("pypi", [
    "1.0.dev1", "1.0a1", "1.0b1", "1.0rc1", "1.0", "1.0.post1", "1.0.post2", "1.1", "2.0",
  ]);
  assert.ok(comparatorFor("pypi").compare("1!0.1", "0!9.9") > 0, "an epoch dominates the release series");
  assert.ok(comparatorFor("pypi").compare("1!1.0", "2.0") > 0, "epoch 1 beats any epoch-0 release");
  assert.equal(comparatorFor("pypi").compare("1.0+abc", "1.0+def"), 0, "local versions do not affect precedence");
  chain("pypi", ["1.0a1.dev1", "1.0a1", "1.0"]);
});

test("pypi PEP 440 specifiers: ~=, == with .*, !=, comma AND, pre-release exclusion", () => {
  const sat = (v: string, s: string) => comparatorFor("pypi").satisfies(v, s);
  assert.ok(sat("1.4.2", "~=1.4.2") && sat("1.4.9", "~=1.4.2") && !sat("1.5.0", "~=1.4.2"));
  assert.ok(sat("1.0.1", "==1.0.*") && !sat("1.1.0", "==1.0.*"));
  assert.ok(sat("1.1.0", "!=1.0.*") && !sat("1.0.5", "!=1.0.*"));
  assert.ok(sat("2.5.0", ">=2.0, <3") && !sat("3.0.0", ">=2.0, <3"));
  assert.ok(!sat("2.0.0a1", ">=2.0, <3"), "specifiers without a pre-release exclude pre-releases");
  assert.ok(sat("2.0.0a1", ">=2.0a1, <3"));
  assert.ok(sat("1.0", "===1.0") && !sat("1.0.0", "===1.0"), "=== is arbitrary equality on the string");
});

test("maven ComparableVersion: qualifier order, zero equivalence, and ranges with (] bounds", () => {
  // Published vectors, verified against org.apache.maven.artifact.versioning.ComparableVersion (Maven 3.9.6):
  // alpha < beta < milestone < rc < snapshot < release < sp < an unknown qualifier < the next numeric segment.
  chain("maven", ["1.0-alpha", "1.0-beta", "1.0-milestone", "1.0-rc", "1.0-SNAPSHOT", "1.0", "1.0-sp1", "1.0.1"]);
  assert.equal(cmp("maven", "1.0-cr", "1.0-rc"), 0, "cr is the rc qualifier");
  assert.equal(cmp("maven", "1.0-ga", "1.0"), 0, "ga names the release");
  assert.equal(cmp("maven", "1.0-final", "1.0"), 0, "final names the release");
  assert.equal(cmp("maven", "1.0.0", "1.0"), 0, "trailing zeros are not a new version");
  chain("maven", ["1.0-sp1", "1.0-a", "1.0.1"]); // an unknown qualifier sorts after sp and before the next number
  const sat = (v: string, r: string) => comparatorFor("maven").satisfies(v, r);
  assert.ok(sat("1.5", "[1.0,2.0)") && !sat("2.0", "[1.0,2.0)"));
  assert.ok(sat("1.0", "[1.0]") && !sat("1.0.1", "[1.0]"));
  assert.ok(sat("0.9", "(,1.0]") && !sat("1.0.1", "(,1.0]"));
  assert.ok(sat("1.0", "1.0") && !sat("1.0.1", "1.0"), "a soft requirement is an exact match");
});

test("unparseable input throws VersionError — never a silent comparison", () => {
  for (const eco of ["npm", "cargo", "golang", "pypi", "maven"] as const) {
    assert.throws(() => comparatorFor(eco).compare(eco === "maven" ? "!!!" : "not-a-version", "1.0.0"), VersionError, eco);
    assert.ok(!comparatorFor(eco).valid("not-a-version"), eco);
  }
  assert.throws(() => comparatorFor("npm").satisfies("1.0.0", "latest"), VersionError, "a tag range cannot be judged");
  assert.throws(() => comparatorFor("npm").satisfies("1.0.0", "git+https://github.com/x/y.git#main"), VersionError);
});

// ---- ordering-law property tests over generated version lists

function* genVersions(eco: "npm" | "cargo" | "golang" | "pypi" | "maven", n: number): Generator<string> {
  let seed = 42 + eco.length;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(rand() * 3), b = Math.floor(rand() * 5), c = Math.floor(rand() * 9);
    if (eco === "golang") yield `v${a}.${b}.${c}`;
    else if (eco === "pypi") yield rand() < 0.3 ? `${a}.${b}.post${c}` : `${a}.${b}.${c}`;
    else if (eco === "maven") yield `${a}.${b}.${c}`;
    else yield `${a}.${b}.${c}`;
  }
  // a few pre-releases and long forms to exercise the interesting paths
  if (eco === "npm" || eco === "cargo") { yield "1.0.0-alpha"; yield "1.0.0-alpha.2"; yield "1.0.0-rc.1"; yield "2.0.0-beta.11"; }
  if (eco === "golang") { yield "v1.0.0-rc.1"; yield "v1.0.0"; }
  if (eco === "pypi") { yield "1.0.dev1"; yield "1.0a1"; yield "1.0rc1"; yield "0!1.0"; yield "2!0.0.1"; }
  if (eco === "maven") { yield "1.0-RC1"; yield "1.0-SNAPSHOT"; yield "1.0"; yield "1.0-sp1"; }
}

for (const eco of ["npm", "cargo", "golang", "pypi", "maven"] as const) {
  test(`property: ${eco} compare is a total order on generated versions (reflexive, antisymmetric, transitive)`, () => {
    const c = comparatorFor(eco);
    const vs = [...genVersions(eco, 40)];
    for (const v of vs) assert.equal(c.compare(v, v), 0, `${v} == ${v}`);
    for (const a of vs) for (const b of vs) assert.ok(c.compare(a, b) === -c.compare(b, a), `antisymmetry ${a} ${b}`);
    for (const a of vs) for (const b of vs) for (const d of vs) {
      if (c.compare(a, b) <= 0 && c.compare(b, d) <= 0) assert.ok(c.compare(a, d) <= 0, `transitivity ${a} <= ${b} <= ${d}`);
    }
  });
}
