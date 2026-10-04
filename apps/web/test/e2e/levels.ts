// A new map starts at the finest level that fits with readable labels, which on a small screen can be a level of groups. These tests are about
// reading and keyboard use of individual symbols, so they step down to the symbol level first, with the same "+" key a person would press.
import type { Browser } from "./cdp.ts";

export async function toSymbolLevel(b: Browser) {
  await b.tabTo(`el.getAttribute('role') === 'application'`);
  for (let i = 0; i < 6 && !(await b.eval<boolean>(`/L5 ·/.test(document.body.innerText)`)); i++) { await b.key("+"); await new Promise((r) => setTimeout(r, 700)); }
  await b.waitFor(() => `/L5 ·/.test(document.body.innerText)`, 5000, "the symbol level");
}
