// Runs C24 causality intake+reconstruction in its own process so a test can kill it at a named failpoint (CIE_FAILPOINT,
// SIGKILL, no cleanup) and then inspect what a real crash leaves behind (RC22).
import { Service, type Service as SvcShape } from "../../src/service.ts";
import { Store } from "../../src/store.ts";
import { WorkerClient } from "../../src/worker.ts";
import { StubProvider } from "@cie/model";

const [dbPath, mode] = process.argv.slice(2);
const worker = new WorkerClient();
const svc = new Service(new Store(dbPath), worker, new StubProvider());
const ctx = (k: string) => ({ requestId: k, idempotencyKey: k, actor: { principalId: "child", tenantId: "t", sessionId: "s" }, deadlineMs: Date.now() + 120_000, traceId: k });
void (0 as unknown as SvcShape);

const events = [
  { id: "e:k1", kind: "OP_START", tenantId: "t", sourceId: "src:c24-crash", sourceEpoch: "1", sourceSequence: "1", processEpoch: "p1", taskId: "t:1", operationId: "op:checkout", time: { observed: 10, domain: "wall", epoch: "1", quality: "BOUNDED" }, attributes: {} },
  { id: "e:k2", kind: "SEND", tenantId: "t", sourceId: "src:c24-crash", sourceEpoch: "1", sourceSequence: "2", processEpoch: "p1", taskId: "t:1", operationId: "op:checkout", time: { observed: 20, domain: "wall", epoch: "1", quality: "BOUNDED" }, attributes: {} },
] as any[];

if (mode === "crash-mid-intake" || mode === "crash-mid-projection") {
  svc.c24.registerAdapter({ adapterId: "src:c24-crash", version: "1", sourceNamespaces: ["src:c24-crash"], edgeKinds: ["PROGRAM_ORDER"], certifiesProgramOrder: true, trusted: true });
  const r = svc.c24.ingestEvents({ batch: events, watermark: { sourceId: "src:c24-crash", sourceEpoch: "1", acceptedSequence: "2", eventTimeWatermark: null, allowedLatenessMs: 600000, finalForWindow: false }, expectedSourceVersion: 0 });
  if (!r.ok) throw new Error("ingest failed: " + r.error.message);
  const res = await svc.c24.reconstruct({ tenantId: "t", revisionSet: ["rev:1"], incidentWindow: { from: 0, to: 1000 } }, {});
  if (!res.ok) throw new Error("reconstruct failed: " + res.error.message);
  console.log(JSON.stringify({ id: res.value.snapshot.id, version: res.value.snapshot.version }));
} else if (mode === "recover") {
  svc.c24.registerAdapter({ adapterId: "src:c24-crash", version: "1", sourceNamespaces: ["src:c24-crash"], edgeKinds: ["PROGRAM_ORDER"], certifiesProgramOrder: true, trusted: true });
  const src = svc.c24.store.db.prepare("select version from c24_runtime_sources where id = ?").get("src:c24-crash") as { version: number } | undefined;
  const r = svc.c24.ingestEvents({ batch: events, watermark: { sourceId: "src:c24-crash", sourceEpoch: "1", acceptedSequence: "2", eventTimeWatermark: null, allowedLatenessMs: 600000, finalForWindow: false }, expectedSourceVersion: src?.version ?? 0 });
  if (!r.ok) throw new Error("ingest failed: " + r.error.message);
  void (await svc.c24.reconstruct({ tenantId: "t", revisionSet: ["rev:1"], incidentWindow: { from: 0, to: 1000 } }, {}));
  console.log(JSON.stringify({ recovered: true }));
} else if (mode === "count") {
  const n = Number((svc.c24.store.db.prepare("select count(*) as n from c24_event_refs").get() as any).n);
  const snaps = (svc.c24.store.db.prepare("select id, version from c24_snapshots").all() as any[]);
  console.log(JSON.stringify({ events: n, snapshots: snaps }));
}
worker.close();