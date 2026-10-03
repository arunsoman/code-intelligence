import { db } from "../db/db";
import { InsufficientFundsError } from "../errors";

export interface Account { id: string; balance: number; held: number }
const accounts = new Map<string, Account>();

export function getAccount(id: string): Account {
  return accounts.get(id) ?? { id, balance: 0, held: 0 };
}

export async function reserve(id: string, amount: number) {
  return db.transaction(async () => {
    const account = getAccount(id);
    if (account.balance - account.held < amount) throw new InsufficientFundsError(id);
    account.held += amount;
    await db.update("accounts", { held: account.held });
  });
}

export async function commit(id: string, amount: number) {
  return db.transaction(async () => {
    const account = getAccount(id);
    account.balance -= amount;
    account.held -= amount;
    await db.update("accounts", { balance: account.balance, held: account.held });
  });
}

// Used by background jobs; deliberately not transactional.
export async function adjustBalance(id: string, delta: number) {
  const account = getAccount(id);
  account.balance += delta;
  await db.update("accounts", { balance: account.balance });
}
