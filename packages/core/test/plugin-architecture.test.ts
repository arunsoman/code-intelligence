import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHART_REGISTRY, ChartDescriptorSchema, ChartOutputV2, type EvidenceBundle, SCHEMA_CHART_V2, type ViewRoute } from "@cie/schema";
import { StubProvider } from "@cie/model";
import { CHART_MODULES } from "../src/plugins/charts/index.ts";
import { compileChartPlan } from "../src/chart-creator.ts";
import { compileLegacyChartPlan } from "../src/chart-compilers.ts";
import { generate, unique, validatePairings } from "../../../scripts/generate-plugins.ts";
const bundle: EvidenceBundle = { id: "bundle", revision: "rev", evidence: [], entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 0 };
const rev = { id: "rev", repoRoot: "/r", gitHead: null, createdAt: "t", analyzerVersion: "t", diagnostics: [], fileCount: 0 };
const route: ViewRoute = { source: "chosen", confidence: "high", form: "GeneratedChart", name: "Selected chart", because: "", alternatives: [] };

test("discovered metadata and compiler registrations cover the same declared capabilities", () => {
  assert.equal(generate(true).charts, Object.keys(CHART_REGISTRY).length);
  assert.deepEqual(Object.keys(CHART_MODULES).sort(), Object.keys(CHART_REGISTRY).sort());
  for (const [id, plugin] of Object.entries(CHART_MODULES)) assert.deepEqual(plugin.descriptor, CHART_REGISTRY[id as keyof typeof CHART_REGISTRY]);
  assert.equal(CHART_MODULES.S29.status, "unavailable");
});

test("discovery rejects duplicate identities and missing renderer pairings", () => {
  assert.throws(() => unique([{ id: "S9" }, { id: "S9" }]), /Duplicate/);
  assert.throws(() => ChartDescriptorSchema.parse({ ...CHART_REGISTRY.S9, requiredKinds: ["invented-proof"] }));
  assert.throws(() => validatePairings([{ id: "S9", renderer: "missing" }], []), /missing renderer/);
  assert.throws(() => validatePairings([], [{ id: "view-spec" }, { id: "view-spec" }]), /Duplicate/);
});

test("all available compiler adapters preserve existing empty-evidence behavior", async () => {
  const stub = new StubProvider();
  for (const descriptor of Object.values(CHART_REGISTRY)) {
    if (descriptor.compiler === "missing") continue;
    const plan = ChartOutputV2.parse(await stub.generate({ purpose: "CHART", schemaId: SCHEMA_CHART_V2, question: "q", bundle, chartId: descriptor.id }));
    const input = { plan, bundle, rev, question: "q", route, chartId: descriptor.id };
    assert.deepEqual(compileChartPlan(input), compileLegacyChartPlan(input), descriptor.id);
  }
});

test("explicit notation mismatch is rejected before any compiler runs", async () => {
  const plan = ChartOutputV2.parse(await new StubProvider().generate({ purpose: "CHART", schemaId: SCHEMA_CHART_V2, question: "q", bundle, chartId: "S9" }));
  assert.throws(() => compileChartPlan({ plan, bundle, rev, question: "q", route, chartId: "S3" }), /Requested S3/);
  assert.throws(() => compileChartPlan({ plan: { chartType: "custom", layout: "flow", caption: "", nodes: [], edges: [] }, bundle, rev, question: "q", route, chartId: "S29" }), /No compiler/);
});


test("production compiler imports pass through the facade or a discovered chart adapter", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!file.endsWith(".ts")) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        const spec = statement.moduleSpecifier;
        if (!spec || !ts.isStringLiteral(spec) || !spec.text.endsWith("chart-compilers.ts")) continue;
        assert.ok(file === join(root, "chart-creator.ts") || file.startsWith(join(root, "plugins/charts/")) && file.endsWith(".chart.ts"), `Compiler registration bypass: ${file}`);
      }
    }
  };
  visit(root);
});
