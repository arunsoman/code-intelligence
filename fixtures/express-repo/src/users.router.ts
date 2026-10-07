import { Router } from "express";

export const usersRouter = Router();

usersRouter.get("/", (req, res) => {
  res.json([]);
});

usersRouter.get("/:id", (req, res) => {
  res.json({ id: req.params.id });
});

usersRouter.post("/", (req, res) => {
  res.json({ created: req.body });
});
