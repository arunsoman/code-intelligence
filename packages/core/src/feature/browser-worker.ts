// Trusted harness entry point. Invoke through runBrowserValidation and an audited container/VM Runner.
import { readFileSync } from "node:fs";
import { Browser } from "./browser-cdp.ts";
import { cdpBrowserDriver, runBrowserJourneys, type BrowserPlan } from "./browser.ts";
const plan = JSON.parse(readFileSync(process.argv[2], "utf8")) as BrowserPlan;
const report = await runBrowserJourneys(async () => cdpBrowserDriver(await Browser.launch()), plan);
process.stdout.write(JSON.stringify(report));
process.exitCode = report.complete && report.outcomes.every((o) => o.state === "PASS") ? 0 : 1;
