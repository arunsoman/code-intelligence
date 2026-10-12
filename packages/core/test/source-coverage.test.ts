import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity } from "@cie/schema";
import { coveredChildren } from "../src/source-coverage.ts";
const entity = (id: string, kind: string, start: number, end: number, hash = "hash", file = "source.ts") => ({ entityId: id, kind, file, spans: [{ sourceId: file, contentHash: hash, startByte: start, endByteExclusive: end }] }) as Entity;

test("a file read covers contained methods using byte spans, including multibyte prefixes", () => {
  const text = "// π\nfunction refund() {}", start = Buffer.byteLength("// π\n");
  const child = entity("method", "method", start, Buffer.byteLength(text));
  const result = coveredChildren(entity("file", "file", 0, 0), text, { total: text.length, contentHash: "hash", ranges: [[0, text.length]] }, [child]);
  assert.equal(result[0].entity.entityId, "method"); assert.equal(result[0].total, "function refund() {}".length);
});

test("class pages need complete contiguous coverage and the same source hash/file", () => {
  const parent = entity("class", "class", 10, 30), text = "01234567890123456789";
  const children = [entity("method", "method", 14, 26), entity("stale", "method", 14, 26, "other"), entity("other-file", "method", 14, 26, "hash", "other.ts"), entity("empty", "method", 15, 15)];
  const read = { total: 20, contentHash: "hash", ranges: [[0, 8], [12, 20]] as [number, number][] };
  assert.deepEqual(coveredChildren(parent, text, read, children), []);
  read.ranges.push([8, 12]);
  assert.deepEqual(coveredChildren(parent, text, read, children).map(h => h.entity.entityId), ["method"]);
});
