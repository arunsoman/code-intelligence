import { getUser } from "../db/users";
import jwt from "jsonwebtoken";

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET ?? "dev");
}

export function verifyToken(token: string) {
  const claims: any = jwt.verify(token, process.env.JWT_SECRET ?? "dev");
  return getUser(claims.sub);
}
