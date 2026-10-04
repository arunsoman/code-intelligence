export function createInvoice(total: number) { return { total, paid: false }; }
export function markPaid(inv: { paid: boolean }) { inv.paid = true; return inv; }
