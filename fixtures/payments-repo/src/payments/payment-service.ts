import { queue } from "../bus/queue";
import * as ledger from "../ledger/ledger";
import { claimKey } from "./idempotency";
import { checkFraud } from "./fraud";
import { authorize } from "./gateway-client";

export async function charge(accountId: string, amount: number, card: string, idempotencyKey: string) {
  claimKey(idempotencyKey);
  checkFraud(accountId, amount);
  await ledger.reserve(accountId, amount);
  await authorize(card, amount);
  // Capture happens asynchronously; the caller sees success before funds actually move.
  queue.publish("payment.capture.requested", { accountId, amount, card });
}
