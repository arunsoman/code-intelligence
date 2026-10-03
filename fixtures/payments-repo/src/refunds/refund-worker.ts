import { queue } from "../bus/queue";
import { adjustBalance } from "../ledger/ledger";

export async function handleRefund(payload: { accountId: string; amount: number }) {
  await adjustBalance(payload.accountId, payload.amount);
}

export function startRefundWorker() {
  queue.subscribe("refund.requested", handleRefund);
}
