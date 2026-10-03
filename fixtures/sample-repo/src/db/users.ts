const users = new Map<string, { id: string; email: string; hash: string }>();

export function findByEmail(email: string) {
  return [...users.values()].find((u) => u.email === email);
}

export function getUser(id: string) {
  return users.get(id);
}
