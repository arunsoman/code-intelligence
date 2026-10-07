// Bundles and renders the Validate and Deliver stages in a child process (same reason as a11y-run.ts: the bundle holds stdio open).
import * as esbuild from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const out: { html?: Record<string, string>; findings?: Record<string, unknown[]>; error?: string } = {};
try {
  const tmp = mkdtempSync(join(tmpdir(), "bd-"));
  await esbuild.build({ entryPoints: [join(here, "build-deliver-entry.tsx")], outfile: join(tmp, "e.js"), bundle: true, format: "esm", jsx: "automatic", platform: "browser", define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "empty" } });
  await esbuild.stop();
  const m = (await import(pathToFileURL(join(tmp, "e.js")).href)) as { render: () => Record<string, string>; auditMarkup: (h: string) => unknown[] };
  out.html = m.render(); // auditMarkup checks a whole page; a fragment legitimately has no h1, landmarks or live region, so only the per-control findings count here.
  out.findings = Object.fromEntries(Object.entries(out.html).map(([k, h]) => [k, m.auditMarkup(h).filter((f) => !["headings", "landmarks", "live-region", "keyboard-help"].includes((f as { kind: string }).kind))]));
  rmSync(tmp, { recursive: true, force: true });
} catch (e) { out.error = String((e as Error)?.stack ?? e); }
console.log(JSON.stringify(out)); process.exit(0);
