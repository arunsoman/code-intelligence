// Test hook for crash-safety: with CIE_FAILPOINT=<name> the process dies at that point, as a kill -9 would
// (no cleanup, no flush). Without it this is a no-op, so production code carries no behaviour change.
export function failpoint(name: string) {
  if (process.env.CIE_FAILPOINT === name) process.kill(process.pid, "SIGKILL");
}
