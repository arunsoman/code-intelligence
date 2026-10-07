// Fixture for R-DEBUG-LEFTOVER and R-TODO-SCAN (C25).
export function loudCompute(x: number) {
  console.log("computing", x);
  return x * 2;
}

export function stoppedShort(x: number) {
  debugger;
  return x + 1;
}

export function quietCompute(x: number) {
  // console.log("not actually called", x);
  return x - 1;
}

export function pendingWork(x: number) {
  // TODO: handle the negative case
  return x;
}

export function knownIssue(x: number) {
  /* HACK: short-circuit until the real fix lands */
  return x;
}

export function clean(x: number) {
  return x * 3;
}
