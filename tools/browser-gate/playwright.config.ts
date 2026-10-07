import { defineConfig } from "@playwright/test";
// The three viewports D004 names. Every project runs every spec; traces are kept for every test so a failure can be replayed.
const VIEWPORTS = { "1366x768": { width: 1366, height: 768 }, "1920x1080": { width: 1920, height: 1080 }, "1280x720": { width: 1280, height: 720 } };
export default defineConfig({
  testDir: "./specs", outputDir: `${process.env.GATE_OUT ?? "/out"}/artifacts`, timeout: 60_000, retries: 0, workers: 1, fullyParallel: false,
  reporter: [["list"], ["json", { outputFile: `${process.env.GATE_OUT ?? "/out"}/results.json` }]],
  use: { baseURL: process.env.GATE_URL, trace: "on", launchOptions: { args: ["--no-sandbox"] } }, // the container is the sandbox; recorded in the report
  projects: Object.entries(VIEWPORTS).map(([name, viewport]) => ({ name, use: { viewport } })),
});
