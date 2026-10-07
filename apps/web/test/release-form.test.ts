import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { freezeSelection, parseRepo, scopeCounts } from "../src/release-form.ts";

describe("parseRepo", () => {
  test("accepts owner/repo and the shapes people paste", () => {
    for (const t of ["arunsoman/code-intelligence", "/arunsoman/code-intelligence", "arunsoman/code-intelligence/", " github.com/arunsoman/code-intelligence ", "https://github.com/arunsoman/code-intelligence.git", "https://github.com/arunsoman/code-intelligence/milestones"]) {
      assert.deepEqual(parseRepo(t), { owner: "arunsoman", repo: "code-intelligence" }, t);
    }
  });
  test("refuses text that is not a repository", () => {
    for (const t of ["", "acme", "/", "acme/ wid gets", "a b/c"]) assert.equal(parseRepo(t), null, t);
  });
});

describe("scope selection", () => {
  const items = [{ number: 1, included: true }, { number: 2, included: false }, { number: 99, included: true, manual: true }];
  test("counts committed vs stretch", () => assert.deepEqual(scopeCounts(items), { committed: 2, stretch: 1, total: 3 }));
  test("freezes exactly the ticked issues and names the ones added by number", () => {
    assert.deepEqual(freezeSelection(items), { include: [1, 99], manual: [99] });
  });
});
