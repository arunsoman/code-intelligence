import { canReadTransactions, type User } from "./auth.ts";
import { listTransactions, type Db, type Transaction } from "./transactions.ts";

export type Response<T> = { status: 200 | 403; body: T | { error: string } };

export function getTransactions(user: User, db: Db): Response<Transaction[]> {
  if (!canReadTransactions(user)) return { status: 403, body: { error: "not allowed" } };
  return { status: 200, body: listTransactions(db, user.tenantId) };
}
