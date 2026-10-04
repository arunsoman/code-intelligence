import { removeAccount, saveProfile } from "../data/store";
import { requireOwner } from "./auth";
import { hashId, maskEmail } from "../util/audit";

// Seeded: the password and the email go to the log in clear.
export function registerUser(req: any, res: any) {
  console.log("new user", req.body.email, req.body.password);
  res.status(201).end();
}

// Seeded: deletes any account for any caller; nothing checks who is asking.
export function deleteAccountHandler(req: any, res: any) {
  removeAccount(req.body.id);
  res.status(204).end();
}

// Not a finding: the owner is checked before the write.
export function updateProfileHandler(req: any, res: any) {
  requireOwner(req.user, req.body.id);
  saveProfile(req.body.id, req.body.name);
  res.status(200).end();
}

// Not findings: constants, sanitised values, derived non-secrets, and code in comments or strings.
export function ping(req: any, res: any) {
  console.log("ping", Date.now());
  console.log("login attempt", hashId(req.body.email));
  console.log("masked", maskEmail(req.body.email));
  console.log("password length", req.body.password.length);
  console.log("the word password and email appear only in this string");
  // console.log(req.body.password)
  res.status(200).end();
}

// Seeded: the same leak written through an alias of the logger. The alias is resolved, so it is found too.
export function aliasedLogger(user: { password: string }) {
  const out = console;
  out.log("created", user.password);
}

// Not a finding: an alias of the logger, but only a derived non-secret is written.
export function aliasedSafe(user: { name: string }) {
  const out = console;
  out.log("created", user.name.length);
}
