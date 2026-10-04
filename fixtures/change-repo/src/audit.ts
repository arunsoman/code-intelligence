import { stillUsed } from "./unused.ts";

export function record(): number {
  return stillUsed();
}
