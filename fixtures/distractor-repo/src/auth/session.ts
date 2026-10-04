export class AuthError extends Error {}

export function verifyToken(token: string): boolean {
  if (!token || token.length < 8) throw new AuthError("malformed token");
  return token.startsWith("tok_");
}

export function login(user: string, token: string): string {
  if (!verifyToken(token)) throw new AuthError("bad credentials");
  return `session:${user}`;
}
