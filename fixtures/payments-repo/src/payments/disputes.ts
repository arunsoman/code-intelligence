import { queue } from "../bus/queue";

export function openDispute(accountId: string, amount: number) {
  queue.publish("refund.requested", { accountId, amount });
}
