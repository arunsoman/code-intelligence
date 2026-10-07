export async function requireAuth(req: any, res: any, next: () => void) {
  if (!req.headers.authorization) {
    return res.status(401).end();
  }
  next();
}
