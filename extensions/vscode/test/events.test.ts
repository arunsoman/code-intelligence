import assert from "node:assert/strict";
import { test } from "node:test";
import { EventStream, isLoopback, reportable } from "../src/events.ts";

test("events are sequenced per session, lines become 1-based, and only paths and lines are carried", () => {
  const s = new EventStream("sess");
  const a = s.make("SELECTION", "/r/a.ts", 4, 9), b = s.make("OPEN_FILE", "/r/b.ts");
  assert.deepEqual(a, { sessionId: "sess", sequence: 0, kind: "SELECTION", file: "/r/a.ts", startLine: 5, endLine: 10 });
  assert.deepEqual(b, { sessionId: "sess", sequence: 1, kind: "OPEN_FILE", file: "/r/b.ts" });
  assert.deepEqual(Object.keys(a).sort(), ["endLine", "file", "kind", "sequence", "sessionId", "startLine"], "no text field exists on the wire");
  assert.equal(s.make("SELECTION", "/r/a.ts", 3, 3).endLine, undefined, "a caret is a single line");
});

test("rapid selection changes coalesce to the newest", () => {
  const s = new EventStream("s");
  for (let i = 0; i < 5; i++) s.coalesce(s.make("SELECTION", "/r/a.ts", i, i));
  const e = s.flush();
  assert.equal(e!.startLine, 5);
  assert.equal(s.flush(), null);
});

test("only loopback servers and real files are used", () => {
  assert.ok(isLoopback("http://127.0.0.1:4317") && isLoopback("http://localhost:4317"));
  assert.ok(!isLoopback("http://evil.example:4317") && !isLoopback("ftp://127.0.0.1") && !isLoopback("not a url"));
  assert.ok(reportable("file", "/r/a.ts"));
  assert.ok(!reportable("git", "/r/a.ts") && !reportable("untitled", "") && !reportable("file", "/r/node_modules/x/y.ts"));
});
