// Runs the real router model against whatever is installed (CIE_LIVE_MODEL names one explicitly; otherwise the first
// `ollama list` reports), so this never depends on a model name baked into the suite. Skipped with nothing installed.
// A sample of every labelled set, as written and with typing mistakes, so a regression in the prompt, the examples or
// the model shows up here. The full measurement is scripts/eval-tiny-models.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listInstalledModels } from "@cie/model";
import { OllamaRouter, candidateLabels, readText } from "../src/llm-router.ts";
import { DEV, HELD_OUT_V3 } from "./route-sets.ts";

const installed = await listInstalledModels();
const model = process.env.CIE_LIVE_MODEL ?? installed?.[0] ?? null;

test("the real router model reads a sample of labelled questions", { skip: model ? false : "no CIE_LIVE_MODEL and no model installed in a local Ollama", timeout: 600_000 }, async () => {
  const router = new OllamaRouter({ model: model! });
  const sample = [...DEV.filter((_, i) => i % 6 === 0), ...HELD_OUT_V3.filter((_, i) => i % 5 === 0)].slice(0, 30);
  let hit = 0; const wrong: string[] = [];
  for (const [q, form, kind] of sample) {
    const r = await readText(router, q, { hasView: false, selectionCount: 0, looksLikeTrace: false }, true);
    const got = r.intent.type === "ask" ? r.intent.route : undefined;
    if (got?.source === "model" && got.form === form && (got.kind ?? undefined) === kind) hit++; else wrong.push(`${q} → ${got?.form}${got?.kind ? ":" + got.kind : ""} (${got?.source})`);
  }
  console.log(`  live ${model}: ${hit}/${sample.length}`, wrong);
  assert.ok(hit / sample.length >= 0.6, `${hit}/${sample.length}`);
  const arch = await readText(router, "what archtecture does this project follow?", { hasView: false, selectionCount: 0, looksLikeTrace: false });
  assert.equal(arch.intent.type, "overview", "the question that started this");
  assert.ok(candidateLabels({ hasView: false, selectionCount: 0, looksLikeTrace: false }).includes("overview"));
});
