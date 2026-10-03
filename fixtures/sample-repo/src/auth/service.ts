import { findByEmail } from "../db/users";
import { checkPassword } from "./password";
import { signToken } from "./token";

export class AuthService {
  async login(email: string, pw: string) {
    const user = await findByEmail(email);
    if (!user || !(await checkPassword(pw, user.hash))) {
      this.audit(email);
      throw new Error("invalid credentials");
    }
    return signToken(user.id);
  }

  audit(email: string) {
    console.warn("failed login", email);
  }
}
