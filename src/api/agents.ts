import { Router } from "express";
import { z } from "zod";
import { bus } from "../events";
import { db } from "../store/db";

export const agentsRouter = Router();

const AgentInput = z.object({
  name: z.string().min(1).max(120),
  systemPrompt: z.string().max(8000).optional(),
  greeting: z.string().max(2000).optional(),
  language: z.string().max(20).optional(),
  ttsModel: z.string().max(60).optional(),
  ttsSpeaker: z.string().max(60).optional(),
  transferNumber: z.string().max(40).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(16).max(2000).optional(),
});

agentsRouter.get("/", (_req, res) => {
  res.json(db.listAgents());
});

agentsRouter.post("/", (req, res) => {
  const parsed = AgentInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const agent = db.createAgent(parsed.data);
  bus.emitEvent({ type: "agent.updated", agent });
  res.status(201).json(agent);
});

agentsRouter.get("/:id", (req, res) => {
  const agent = db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "not found" });
  res.json(agent);
});

agentsRouter.put("/:id", (req, res) => {
  const parsed = AgentInput.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const agent = db.updateAgent(req.params.id, parsed.data);
  if (!agent) return res.status(404).json({ error: "not found" });
  bus.emitEvent({ type: "agent.updated", agent });
  res.json(agent);
});

agentsRouter.delete("/:id", (req, res) => {
  const ok = db.deleteAgent(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
