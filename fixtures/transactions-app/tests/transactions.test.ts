import assert from "node:assert/strict";
import { test } from "node:test";
import { getTransactions } from "../src/api.ts";
import type { Db } from "../src/transactions.ts";

const db: Db = { transactions: [
  { id: "t1", tenantId: "acme", amountCents: 1250, currency: "USD", createdAt: "2026-10-01T10:00:00Z" },
  { id: "t2", tenantId: "acme", amountCents: 990, currency: "USD", createdAt: "2026-10-02T10:00:00Z" },
  { id: "t3", tenantId: "globex", amountCents: 500, currency: "EUR", createdAt: "2026-10-03T10:00:00Z" },
] };

test("a member sees only their own tenant's transactions, newest first", () => {
  const r = getTransactions({ id: "u1", tenantId: "acme", role: "member" }, db);
  assert.equal(r.status, 200); assert.deepEqual((r.body as { id: string }[]).map((t) => t.id), ["t2", "t1"]);
});

test("support staff cannot read transactions", () => {
  assert.equal(getTransactions({ id: "u2", tenantId: "acme", role: "support" }, db).status, 403);
});
