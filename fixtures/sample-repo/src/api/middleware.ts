import { verifyToken } from "../auth/token";

export async function requireAuth(req: any, res: any, next: () => void) {
  const user = await verifyToken(req.headers.authorization ?? "");
  if (!user) return res.status(401).end();
  req.user = user;
  next();
}
