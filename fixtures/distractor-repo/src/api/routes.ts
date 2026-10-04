import { login } from "../auth/session";

export function handleLogin(body: { user: string; token: string }) {
  return login(body.user, body.token);
}

export function handleLogout(sessionId: string) {
  return { ok: true, sessionId };
}
