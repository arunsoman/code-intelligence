import { getAccount } from "../ledger/ledger";

export function reconcileBalances(ids: string[], computed: Map<string, number>) {
  for (const id of ids) {
    const account = getAccount(id);
    account.balance = computed.get(id) ?? account.balance;
  }
}
