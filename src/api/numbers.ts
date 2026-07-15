import { Router } from "express";
import { z } from "zod";
import { db } from "../store/db";
import type { NumberRec } from "../store/types";

export const numbersRouter = Router();

// agentId: null (or "") clears the inbound-agent assignment.
const NumberInput = z.object({
  number: z.string().min(3).max(40),
  label: z.string().max(120).optional(),
  agentId: z.string().nullable().optional(),
});

numbersRouter.get("/", (_req, res) => {
  res.json(db.listNumbers());
});

numbersRouter.post("/", (req, res) => {
  const parsed = NumberInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const agentId = parsed.data.agentId || undefined;
  if (agentId && !db.getAgent(agentId)) return res.status(400).json({ error: "unknown agentId" });
  res.status(201).json(db.createNumber({ ...parsed.data, agentId }));
});

numbersRouter.put("/:id", (req, res) => {
  const parsed = NumberInput.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { agentId, ...rest } = parsed.data;
  const patch: Partial<NumberRec> = rest;
  if (agentId !== undefined) {
    if (agentId && !db.getAgent(agentId)) return res.status(400).json({ error: "unknown agentId" });
    patch.agentId = agentId || undefined;
  }
  const rec = db.updateNumber(req.params.id, patch);
  if (!rec) return res.status(404).json({ error: "not found" });
  res.json(rec);
});

numbersRouter.delete("/:id", (req, res) => {
  const ok = db.deleteNumber(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
