// Seeded: a leak in code nothing calls and nothing exposes. It is still a leak in the code, but not a reachable one.
export function legacyExport(user: { ssn: string; name: string }) {
  console.log("exporting", user.name, user.ssn);
}
