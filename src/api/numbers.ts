import { Router } from "express";
import { z } from "zod";
import { db } from "../store/db";

export const numbersRouter = Router();

const NumberInput = z.object({
  number: z.string().min(3).max(40),
  label: z.string().max(120).optional(),
  agentId: z.string().optional(),
});

numbersRouter.get("/", (_req, res) => {
  res.json(db.listNumbers());
});

numbersRouter.post("/", (req, res) => {
  const parsed = NumberInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  res.status(201).json(db.createNumber(parsed.data));
});

numbersRouter.put("/:id", (req, res) => {
  const parsed = NumberInput.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const rec = db.updateNumber(req.params.id, parsed.data);
  if (!rec) return res.status(404).json({ error: "not found" });
  res.json(rec);
});

numbersRouter.delete("/:id", (req, res) => {
  const ok = db.deleteNumber(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
