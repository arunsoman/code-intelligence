export const db = {
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  },
  async update(table: string, patch: Record<string, unknown>) {
    return { table, patch };
  },
};
