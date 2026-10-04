// Runs the bundled a11y audit as its own process so node --test always gets a decisive exit
// (the bundled app holds stdio pipes no matter what, and the runner would otherwise wait).
import * as esbuild from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

const result: { markupFindings: unknown[]; contrastFindings: unknown; textPairs: number; uiPairs: number; indexHtml: string; readme: string; renderError: string | null } = { markupFindings: [], contrastFindings: [], textPairs: 0, uiPairs: 0, indexHtml: "", readme: "", renderError: null };
try {
  const tmp = mkdtempSync(join(tmpdir(), "a11y-"));
  await esbuild.build({
    entryPoints: [join(webRoot, "test/audit-entry.ts")],
    outfile: join(tmp, "audit.js"),
    bundle: true,
    format: "esm",
    jsx: "automatic",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "empty" },
  });
  await esbuild.stop();
  const { App, auditContrast, auditMarkup, renderApp } = (await import(pathToFileURL(join(tmp, "audit.js")).href)) as { App: unknown; auditContrast: (css: string) => unknown; auditMarkup: (html: unknown) => unknown[]; renderApp: (app: unknown) => string };
  result.markupFindings = auditMarkup(renderApp(App));
  result.contrastFindings = auditContrast(readFileSync(join(webRoot, "src/styles.css"), "utf8"));
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  result.renderError = String((e as Error)?.stack ?? e);
}
console.log(JSON.stringify(result));
process.exit(0);