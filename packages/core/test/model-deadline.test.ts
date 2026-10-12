import assert from "node:assert/strict";
import { test } from "node:test";
import { converseWithin } from "../src/model-deadline.ts";
import type { RouterModel } from "../src/llm-router.ts";

test("a model that ignores abort cannot leave its caller pending beyond the deadline", async () => {
 let signal: AbortSignal | undefined;
 const model: RouterModel = { name: "ignores-abort", choose: async () => null, converse: async (_messages, _tools, s) => { signal = s; return new Promise(() => {}); } };
 await assert.rejects(converseWithin(model, [], [], 10), /deadline/);
 assert.equal(signal?.aborted, true);
});
test("timely replies keep method binding and expired budgets do not start calls", async () => {
 let calls = 0;
 const model: RouterModel = { name: "bound", choose: async () => null, converse: async function() { calls++; return { content: this.name, toolCalls: [] }; } };
 assert.equal((await converseWithin(model, [], [], 1000))!.content, "bound");
 await assert.rejects(converseWithin(model, [], [], 0), /deadline/);
 assert.equal(calls, 1);
});
test("late failures are consumed after the bounded caller has timed out", async () => {
 let rejectLate!: (error: Error) => void;
 const model: RouterModel = { name: "late", choose: async () => null, converse: async () => new Promise((_, reject) => { rejectLate = reject; }) };
 await assert.rejects(converseWithin(model, [], [], 10), /deadline/);
 rejectLate(new Error("late adapter failure"));
 await new Promise(resolve => setImmediate(resolve));
});
