import { createPayment, updateProfile } from "./handlers/a";
import { requireAuth } from "./auth";

export function register(app: any, router: any) {
  app.post("/pay", createPayment);
  app.get("/health", (req: any, res: any) => res.json({ ok: true }));
  app.delete("/accounts/:id", removeAccount);
  app.post("/refund", refundHandler);
  router.put("/profile", requireAuth, updateProfile);
}
