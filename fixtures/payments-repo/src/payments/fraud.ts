import { FraudRejectedError } from "../errors";

export function checkFraud(accountId: string, amount: number) {
  if (amount > 10_000) throw new FraudRejectedError(`${accountId} over limit`);
  return velocity(accountId) < 5;
}

function velocity(accountId: string) {
  return accountId.length;
}
