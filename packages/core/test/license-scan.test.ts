// scanManifests/buildSbom: reads whichever manifests exist, never guesses a license.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSbom, scanManifests } from "../src/license-scan.ts";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cie-license-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "demo", dependencies: { lodash: "^4.17.21", express: "^4.19.0" }, devDependencies: { vitest: "^1.0.0" },
  }));
  writeFileSync(join(dir, "Cargo.toml"), [
    "[package]", 'name = "demo"', "", "[dependencies]", 'serde = "1.0"', 'tokio = { version = "1.38", features = ["full"] }',
  ].join("\n"));
  return dir;
}

test("scanManifests finds npm and cargo dependencies with correct names/versions", () => {
  const dir = fixture();
  try {
    const results = scanManifests(dir);
    const npm = results.find((r) => r.ecosystem === "npm")!;
    const cargo = results.find((r) => r.ecosystem === "cargo")!;
    assert.ok(npm, "npm manifest found");
    assert.ok(cargo, "cargo manifest found");
    assert.deepEqual(new Set(npm.dependencies.map((d) => d.name)), new Set(["lodash", "express", "vitest"]));
    assert.equal(npm.dependencies.find((d) => d.name === "lodash")!.version, "^4.17.21");
    assert.deepEqual(new Set(cargo.dependencies.map((d) => d.name)), new Set(["serde", "tokio"]));
    assert.equal(cargo.dependencies.find((d) => d.name === "tokio")!.version, "1.38");
    assert.equal(results.length, 2, "no go.mod or requirements.txt in this fixture, so only two ecosystems");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a manifest-free directory returns an empty array, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "cie-license-empty-"));
  try {
    assert.deepEqual(scanManifests(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildSbom without licenseOf marks everything UNKNOWN and flags nothing", () => {
  const sbom = buildSbom([{ name: "a", version: "1.0.0" }, { name: "b", version: "2.0.0" }]);
  assert.equal(sbom.components.every((c) => c.license === "UNKNOWN"), true);
  assert.equal(sbom.forbidden.length, 0);
});

test("buildSbom flags exactly the component whose resolved license is forbidden", () => {
  const sbom = buildSbom(
    [{ name: "copyleft-lib", version: "1.0.0" }, { name: "permissive-lib", version: "2.0.0" }],
    { licenseOf: (name) => (name === "copyleft-lib" ? "GPL-3.0" : "MIT"), forbiddenLicenses: ["GPL-3.0"] },
  );
  assert.equal(sbom.forbidden.length, 1);
  assert.equal(sbom.forbidden[0]!.name, "copyleft-lib");
  assert.equal(sbom.components.find((c) => c.name === "permissive-lib")!.license, "MIT");
});

test("UNKNOWN is never treated as forbidden even if an empty-string license were listed", () => {
  const sbom = buildSbom([{ name: "mystery", version: "0.0.1" }], { forbiddenLicenses: ["UNKNOWN"] });
  assert.equal(sbom.forbidden.length, 0, "an unresolved license is an absence of data, not a violation");
});
