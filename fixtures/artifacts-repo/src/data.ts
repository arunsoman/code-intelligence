import { db } from "./db";

export async function hold(id: string) {
  await db.update("accounts", { id, held: 1 });
  await db.insert("payments", { id });
  await db.insert("ledger_entries", { id });
}
