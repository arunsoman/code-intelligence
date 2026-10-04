// A process the tests start, and (with CIE_FAILPOINT) kill, to prove what a real crash leaves behind.
import { Journal } from "../../src/journal.ts";
import { EventBus } from "../../src/events.ts";
import { Store } from "../../src/store.ts";
import { failpoint } from "../../src/failpoint.ts";

const [mode, dbPath, arg] = process.argv.slice(2);
const store = new Store(dbPath);
const ctx = (key: string) => ({ requestId: key, idempotencyKey: key, actor: { principalId: "child", tenantId: "t", sessionId: "s" }, deadlineMs: Date.now() + 60_000, traceId: key });
const cmd = (id: string, name: string, expectedVersion = 0) => ({ id, type: "UPDATE_WORKSPACE" as const, subjectId: id, expectedVersion, payload: { name, state: { n: name } } });

if (mode === "submit") {
  new Journal(store).submit(ctx(arg), cmd(arg, `ws-${arg}`));
} else if (mode === "dispatch") {
  store.db.exec("create table if not exists effects(event_id text, n integer)");
  const bus = new EventBus(store);
  bus.subscribe("counter", (ev, s) => { s.db.prepare("insert into effects values (?, 1)").run(ev.eventId); });
  bus.dispatchPending();
} else if (mode === "tx") {
  store.db.exec("create table if not exists scratch(v text)");
  store.tx(() => { store.db.prepare("insert into scratch values ('partial')").run(); failpoint("mid-transaction"); });
} else if (mode === "writer") {
  const j = new Journal(store);
  let failures = 0;
  for (let i = 0; i < 80; i++) { const r = j.submit(ctx(`${arg}-${i}`), cmd(`${arg}-${i}`, `ws-${arg}-${i}`)); if (!r.ok) failures++; }
  console.log(JSON.stringify({ failures }));
}
store.db.close();
