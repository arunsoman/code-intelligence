// How well can the router model (the production prompt: closed label list + the nearest labelled examples) read a developer's question, typos and all?
// Every question in the labelled routing sets is asked twice: as written, and with realistic typing mistakes added by a seeded generator
// (swapped, dropped, doubled and neighbouring-key letters, lower case, no punctuation, filler). Models run through Ollama with a
// constrained JSON answer (one label from the closed list), temperature 0. This runs the same code the product runs (llm-router.ts).
//   node scripts/eval-tiny-models.ts <installed model> [more models]      writes docs/eval-tiny-models.json
import { writeFileSync } from "node:fs";
import { OllamaRouter, candidateLabels, readText } from "../packages/core/src/llm-router.ts";
import { DEV, HELD_OUT, HELD_OUT_V2, HELD_OUT_V3 } from "../packages/core/test/route-sets.ts";

// ---- typing mistakes, deterministic from a seed
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const NEIGH: Record<string, string> = { a: "sqzw", b: "vghn", c: "xdfv", d: "serfcx", e: "wsdr", f: "drtgvc", g: "ftyhbv", h: "gyujnb", i: "ujko", j: "huikmn", k: "jiolm", l: "kop", m: "njk", n: "bhjm", o: "iklp", p: "ol", q: "wa", r: "edft", s: "awedxz", t: "rfgy", u: "yhji", v: "cfgb", w: "qase", x: "zsdc", y: "tghu", z: "asx" };
export function noisy(q: string, seed: number): string {
  const r = rng(seed);
  const words = q.replace(/[?.!,]/g, "").toLowerCase().split(/\s+/).map((w) => {
    if (w.length < 4 || r() > 0.3) return w;
    const i = 1 + Math.floor(r() * (w.length - 2)), op = Math.floor(r() * 4);
    if (op === 0) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);                        // swap
    if (op === 1) return w.slice(0, i) + w.slice(i + 1);                                         // drop
    if (op === 2) return w.slice(0, i) + w[i] + w.slice(i);                                      // double
    const n = NEIGH[w[i]]; return n ? w.slice(0, i) + n[Math.floor(r() * n.length)] + w.slice(i + 1) : w; // neighbouring key
  });
  const filler = r() < 0.2 ? ["pls", "uhh", "hey"][Math.floor(r() * 3)] + " " : "";
  return filler + words.join(" ");
}

const ALL = [...DEV, ...HELD_OUT, ...HELD_OUT_V2, ...HELD_OUT_V3];
const seen = new Set<string>();
export const ITEMS = ALL.filter(([q]) => !seen.has(q) && !!seen.add(q)).map(([q, form, kind]) => ({ q, label: kind ? `${form}:${kind}` : form }));

const wilson = (k: number, n: number) => { const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)]; };

if (import.meta.url === `file://${process.argv[1]}`) {
  const models = process.argv.slice(2);
  const results: any[] = [];
  const ctx = { hasView: false, selectionCount: 0, looksLikeTrace: false };
  for (const model of models) {
    const router = new OllamaRouter({ model });
    for (const variant of ["clean", "typos"]) {
      let ok = 0; const ms: number[] = []; const wrong: string[] = [];
      for (const it of ITEMS) {
        const q = variant === "clean" ? it.q : noisy(it.q, 7 + it.q.length);
        const t = performance.now(), r = await readText(router, q, ctx, true); ms.push(performance.now() - t);
        const got = r.intent.type === "ask" && r.intent.route?.source === "model" ? r.label : null;
        if (got === it.label) ok++; else if (wrong.length < 8) wrong.push(`${q} → ${got} (want ${it.label})`);
      }
      const [lo, hi] = wilson(ok, ITEMS.length), med = [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)];
      results.push({ system: model, variant, n: ITEMS.length, accuracy: ok / ITEMS.length, lo, hi, medianMs: Math.round(med), sampleErrors: wrong });
      console.log(`${model.padEnd(20)} ${variant.padEnd(6)} ${(100 * ok / ITEMS.length).toFixed(0)}% [${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}] ${Math.round(med)} ms`);
    }
  }
  void candidateLabels;
  writeFileSync(new URL("../docs/eval-tiny-models.json", import.meta.url), JSON.stringify({ items: ITEMS.length, at: new Date().toISOString(), prompt: "production (llm-router.ts)", results }, null, 1));
}
