import { ForbiddenError } from "../errors";

export function requireOwner(user: { id: string }, id: string) {
  if (user.id !== id) throw new ForbiddenError("not your account");
}
