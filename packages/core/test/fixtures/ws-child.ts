// Process killed with SIGKILL by c13.test.ts to prove what a real crash leaves of an investigation.
import { Store } from "../../src/store.ts";
import { WorkspaceLog } from "../../src/workspaces.ts";

const [mode, dbPath] = process.argv.slice(2);
const store = new Store(dbPath);
const log = new WorkspaceLog(store);
const view = { id: "v", version: 1, revision: "rev-1", taskId: "t", formId: "SemanticMap", caption: "c", question: "q", level: 4, nodes: [], edges: [], groups: [], legend: [], cameraPolicy: { behavior: "PRESERVE" }, gaps: [] };
if (mode === "material") {
  const c = log.create("a", { name: "crash me", revision: "rev-1", id: "ws:crash" });
  if (!c.ok) throw new Error("create");
  let v = 0;
  for (const event of [{ kind: "SET_VIEW", view }, { kind: "PIN", entityId: "e1", on: true }, { kind: "NOTE", entityId: "e1", text: "suspicious" }, { kind: "HYPOTHESIS", id: "h1", text: "double apply", state: "OPEN" }] as any[]) {
    const r = log.append("a", { workspaceId: "ws:crash", event, expectedVersion: v });
    if (!r.ok) throw new Error("append");
    v = r.version;
  }
  console.log("committed");
  process.kill(process.pid, "SIGKILL"); // no flush, no close
} else if (mode === "ephemeral") {
  log.create("a", { name: "busy", revision: null, id: "ws:busy" });
  log.append("a", { workspaceId: "ws:busy", event: { kind: "NOTE", entityId: "e", text: "before" }, expectedVersion: 0 });
  let i = 0;
  setInterval(() => { log.appendEphemeral("a", "ws:busy", { kind: "SELECT", ids: [`e${i++}`] }); console.log(JSON.stringify({ i, t: Date.now() })); }, 100);
}
