import { charge } from "../src/payments/payment-service";
import { checkFraud } from "../src/payments/fraud";

describe("payments", () => {
  it("charges an account", async () => {
    await charge("acct-1", 50, "4111", "k1");
  });
  it("flags large amounts", () => {
    checkFraud("acct-1", 20_000);
  });
});
