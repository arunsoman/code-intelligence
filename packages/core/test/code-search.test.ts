import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entity } from "@cie/schema";
import type { Store } from "../src/store.ts";
import { OPEN } from "../src/access.ts";
import { sourceCandidates } from "../src/code-search.ts";
const e = (name: string, file: string, kind = "method") => ({ entityId: `${kind}:${file}#${name}`, kind, name, file }) as Entity;
const store = (entities: Entity[]) => ({ entities: () => entities }) as unknown as Store;

test("topup source lookup finds production implementations despite unrelated graph candidates", () => {
  const entities = [e("BusinessPartnerService.processTopup", "business-partners/service.java"), e("RoshanTopUpScheduler.checkPendingTopups", "transactions-service/scheduler.java"),
    e("BudgetController.refund", "packages/model/budget.ts"), e("User", "fixtures/topup/user.java", "class"),
    ...Array.from({ length: 40 }, (_, i) => e("UserService.getHeaders", `web/user/${i}.ts`))];
  const hits = sourceCandidates(store(entities), "r", "what is case where a user pays for topup and then the topup never hapens and the user is not refunded also", OPEN);
  assert.equal(hits[0].name, "BusinessPartnerService.processTopup");
  assert.ok(hits.some(h => h.name.includes("Scheduler")));
  assert.ok(!hits.some(h => h.file.startsWith("web/") || h.file.startsWith("fixtures/")));
});

test("source lookup respects access and explicit fixture requests, normalizes top-up spelling", () => {
  const entities = [e("processTopup", "private/service.java"), e("processTopup", "src/service.java"), e("processTopup", "fixtures/service.java")];
  const access = { ...OPEN, denied: (file: string) => file.startsWith("private/") };
  assert.deepEqual(sourceCandidates(store(entities), "r", "top-up", access).map(h => h.file), ["src/service.java"]);
  assert.equal(sourceCandidates(store(entities), "r", "topup fixtures", access).length, 2);
  assert.deepEqual(sourceCandidates(store(entities), "r", "noMatchingImplementation", access), []);
});
