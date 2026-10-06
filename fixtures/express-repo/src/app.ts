import express from "express";
import { requireAuth } from "./middleware";
import { usersRouter } from "./users.router";

export function createApp() {
  const app = express();

  app.use("/api", requireAuth);

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.post("/login", (req, res) => {
    res.json({ token: "fake" });
  });

  app.use("/users", usersRouter);

  return app;
}
