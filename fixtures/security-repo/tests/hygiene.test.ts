import { loudCompute } from "../src/debug-and-todo";

describe("hygiene fixture (test file, must be skipped by R-DEBUG-LEFTOVER/R-TODO-SCAN)", () => {
  it("calls loudCompute", () => {
    // TODO: this marker and the console.log below must never be reported — this file's path includes "test".
    console.log("skip me", loudCompute(1));
  });
});
