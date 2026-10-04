import { flags } from "./flags";

export function checkout() {
  if (flags.isEnabled("new-checkout")) return "new";
  if (flags.isEnabled("beta-search")) return "beta";
  return "old";
}
