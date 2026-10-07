export type Transaction = { id: string; tenantId: string; amountCents: number; currency: string; createdAt: string };
export type Db = { transactions: Transaction[] };

/** Only the given tenant's rows, newest first. */
export function listTransactions(db: Db, tenantId: string): Transaction[] {
  return db.transactions.filter((t) => t.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
