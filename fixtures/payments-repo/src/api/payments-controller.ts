import { charge } from "../payments/payment-service";
import { DuplicateRequestError } from "../errors";

export async function createPayment(req: any, res: any) {
  try {
    await charge(req.body.accountId, req.body.amount, req.body.card, req.headers["idempotency-key"]);
    res.status(201).end();
  } catch (e) {
    if (e instanceof DuplicateRequestError) return res.status(409).end();
    res.status(500).end();
  }
}
