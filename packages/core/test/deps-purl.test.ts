import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPurl, normalizePackageName, parsePurl, type PurlParts } from "../src/deps/purl.ts";

test("F04-D1-adjacent: purl identity round-trips per ecosystem, scoped npm names are %40-encoded", () => {
  const cases: [PurlParts, string][] = [
    [{ type: "npm", namespace: "@acme", name: "payments", version: "1.2.3" }, "pkg:npm/%40acme/payments@1.2.3"],
    [{ type: "cargo", name: "serde", version: "1.0.200" }, "pkg:cargo/serde@1.0.200"],
    [{ type: "golang", name: "golang.org/x/net", version: "v0.17.0" }, "pkg:golang/golang.org%2Fx%2Fnet@v0.17.0"],
    [{ type: "pypi", name: "django", version: "4.2.1" }, "pkg:pypi/django@4.2.1"],
    [{ type: "maven", namespace: "org.apache.logging.log4j", name: "log4j-core", version: "2.14.1" }, "pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1"],
  ];
  for (const [parts, expected] of cases) {
    const purl = buildPurl(parts);
    assert.equal(purl, expected);
    const parsed = parsePurl(purl);
    assert.equal(parsed.type, parts.type);
    assert.equal(parsed.name, parts.name);
    assert.equal(parsed.version, parts.version);
    assert.equal(parsed.namespace, parts.namespace);
  }
});

test("non-default registries carry repository_url; qualifiers round-trip", () => {
  const purl = buildPurl({ type: "npm", name: "internal-tool", version: "2.0.0", qualifiers: { repository_url: "https://npm.acme.example" } });
  assert.equal(purl, "pkg:npm/internal-tool@2.0.0?repository_url=https%3A%2F%2Fnpm.acme.example");
  const parsed = parsePurl(purl);
  assert.equal(parsed.qualifiers?.repository_url, "https://npm.acme.example");
});

test("name normalisation: npm lower-case, PyPI PEP 503", () => {
  assert.equal(normalizePackageName("npm", "Lodash"), "lodash");
  assert.equal(normalizePackageName("npm", "@Acme/Payments"), "@acme/payments");
  assert.equal(normalizePackageName("pypi", "Scikit_Learn"), "scikit-learn");
  assert.equal(normalizePackageName("cargo", "serde"), "serde");
  assert.equal(normalizePackageName("maven", "org.apache:Log4j"), "org.apache:Log4j");
});

test("parsePurl rejects malformed input", () => {
  assert.throws(() => parsePurl("not-a-purl"), /not a purl/);
  assert.throws(() => parsePurl("pkg:unknown/foo@1.0.0"), /unsupported purl type/);
  assert.throws(() => buildPurl({ type: "npm", name: "" }), /requires a name/);
});
