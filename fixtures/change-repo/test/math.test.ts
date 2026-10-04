import assert from "node:assert/strict";
import { test } from "node:test";
import { add, scale } from "../src/math.ts";
import { doubled, summary, total } from "../src/report.ts";

test("add adds", () => assert.equal(add(2, 3), 5));
test("scale scales", () => assert.equal(scale(4, 3), 12));
test("total sums", () => assert.equal(total([1, 2, 3]), 6));
test("doubled doubles", () => assert.deepEqual(doubled([1, 2]), [2, 4]));
test("summary reads well", () => assert.equal(summary([1, 2]), "total 3"));
