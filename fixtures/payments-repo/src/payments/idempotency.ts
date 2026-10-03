import { DuplicateRequestError } from "../errors";

const seen = new Set<string>();

export function claimKey(key: string) {
  if (seen.has(key)) throw new DuplicateRequestError(key);
  seen.add(key);
}
