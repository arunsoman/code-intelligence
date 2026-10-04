import { Mutex } from "./mutex";
const left = new Mutex("left"), right = new Mutex("right");

// DP02: the same inversion, but the second acquisition gives up after a timeout, so the wait cannot be permanent.
export async function leftThenRight() {
  const l = await left.acquire();
  const r = await right.acquire({ timeout: 50 });
  r.release(); l.release();
}
export async function rightThenLeft() {
  const r = await right.acquire();
  const l = await left.acquire({ timeout: 50 });
  l.release(); r.release();
}
