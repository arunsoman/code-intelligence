// Runs real fixture functions concurrently, many times, with randomized delays. It reports observations only: how many runs
// violated the property. This is stress, not a search: zero violations says nothing about the schedules that were not tried.
import { pathToFileURL } from "node:url";
const [fixture, fn, runsArg, seedArg] = process.argv.slice(2);
const runs = Number(runsArg), seed0 = Number(seedArg);
const mod = await import(pathToFileURL(fixture).href);
const f = mod[fn];
let s = seed0 >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
let violations = 0; const firstBad = [];
for (let i = 0; i < runs; i++) {
  const account = { balance: 0 };
  const boundary = () => new Promise((r) => setTimeout(r, Math.floor(rnd() * 3)));
  await Promise.all([f(account, boundary), f(account, boundary), f(account, boundary)]);
  // The property is written here, independently of the function: three completed increments leave three.
  if (account.balance !== 3) { violations++; if (firstBad.length < 3) firstBad.push({ run: i, balance: account.balance }); }
}
console.log(JSON.stringify({ runs, violations, firstBad, seed: seed0 }));
