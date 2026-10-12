import assert from "node:assert/strict";
import { test } from "node:test";
import { sourcePage } from "../src/chat-tools.ts";

test("source pages preserve every character including later pipeline steps", () => {
  const source = Array.from({ length: 500 }, (_, i) => `step${i}();`).join("\n") + "\nrefund();";
  let offset = 0, restored = "", pages = 0;
  do {
    const page = sourcePage(source, offset);
    restored += page.text;
    pages++;
    if (page.nextOffset === undefined) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (pages < 20);
  assert.equal(restored, source);
  assert.ok(pages > 1);
  assert.match(restored, /refund\(\);$/);
});

test("source paging continues through a line larger than the character budget", () => {
  const source = "x".repeat(30000) + "provider.process();";
  const first = sourcePage(source);
  assert.equal(first.text.length, 14000);
  const second = sourcePage(source, first.nextOffset);
  const last = sourcePage(source, second.nextOffset);
  assert.equal(first.text + second.text + last.text, source);
  assert.equal(last.nextOffset, undefined);
  assert.deepEqual(sourcePage(""), { text: "" });
});
