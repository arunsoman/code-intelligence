export type Role = "member" | "admin" | "support";
export type User = { id: string; tenantId: string; role: Role };

/** Members and admins may read their own tenant's data; support may not. */
export function canReadTransactions(user: User): boolean {
  return user.role === "member" || user.role === "admin";
}
