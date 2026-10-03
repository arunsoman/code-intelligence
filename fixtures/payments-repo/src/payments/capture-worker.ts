import { queue } from "../bus/queue";
import * as ledger from "../ledger/ledger";
import { capture } from "./gateway-client";

export async function handleCapture(payload: { accountId: string; amount: number; card: string }) {
  await capture(payload.card, payload.amount);
  await ledger.commit(payload.accountId, payload.amount);
  queue.publish("payment.completed", { accountId: payload.accountId });
}

export function startCaptureWorker() {
  queue.subscribe("payment.capture.requested", handleCapture);
}
