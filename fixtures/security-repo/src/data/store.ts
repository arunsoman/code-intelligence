const accounts = new Map<string, { id: string; deleted: boolean; name: string }>();
const profiles = new Map<string, { id: string; name: string }>();

export function removeAccount(id: string) {
  const account = accounts.get(id)!;
  account.deleted = true;
}

export function saveProfile(id: string, name: string) {
  const profile = profiles.get(id)!;
  profile.name = name;
}
