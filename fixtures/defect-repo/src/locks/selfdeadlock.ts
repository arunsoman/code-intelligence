import { Mutex } from "./mutex";
const single = new Mutex("single");

// A non-reentrant mutex taken again by something it calls: this one really does wait on itself.
export async function outer() { const g = await single.acquire(); try { await inner(); } finally { g.release(); } }
export async function inner() { const g = await single.acquire(); g.release(); }
