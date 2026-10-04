import { updateProfileHandler } from "../src/api/handlers";
import { saveProfile } from "../src/data/store";

describe("profile", () => {
  it("lets the owner rename", () => {
    updateProfileHandler({ user: { id: "u1" }, body: { id: "u1", name: "A" } }, { status: () => ({ end() {} }) });
  });
  it("saves a profile name", () => {
    saveProfile("u1", "B");
  });
});
