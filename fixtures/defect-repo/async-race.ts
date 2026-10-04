export interface Account { balance: number }

export async function lostIncrement(account: Account, boundary: () => Promise<void>) {
  const before = account.balance;
  await boundary();
  account.balance = before + 1;
}

export async function incrementAfterAwait(account: Account, boundary: () => Promise<void>) {
  await boundary();
  account.balance = account.balance + 1;
}

export async function repeatedLookup(ids: string[], lookup: (id: string) => Promise<unknown>) {
  const results = [];
  for (const id of ids) results.push(await lookup(id));
  return results;
}
