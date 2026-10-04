import { makeCircle } from "./shapes";
import * as util from "./util";
import { external } from "some-package";

function onA() { return 1; }
function onB() { return 2; }
const table: Record<string, () => number> = { a: onA, b: onB };

export function run(kind: string): number {
  const c = makeCircle();
  const base = util.helper(c.area());
  external(base);
  return table[kind]();
}

export function viaAny(obj: any, name: string) {
  return obj[name]();
}
