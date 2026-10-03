import { AuthService } from "../auth/service";
import * as mw from "./middleware";

const auth = new AuthService();

export function registerRoutes(app: any) {
  app.post("/login", async (req: any, res: any) => res.json({ token: await auth.login(req.body.email, req.body.password) }));
  app.get("/me", mw.requireAuth, (req: any, res: any) => res.json(req.user));
  handlers[req.kind]();
}
