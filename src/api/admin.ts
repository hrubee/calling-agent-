import { json, Router } from "express";
import { z } from "zod";
import { warmAllGreetings } from "../agent/greeting";
import { db } from "../store/db";
import type { DBShape } from "../store/types";

/**
 * Admin backup/restore: full JSON-store export and import. Used for volume
 * migrations and off-site backups. Auth is enforced by the /api middleware.
 */
export const adminRouter = Router();

// Schemas mirror src/store/types.ts. `.passthrough()` keeps unknown keys so an
// export from a newer app version survives a round-trip through an older one.
const AgentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    systemPrompt: z.string(),
    greeting: z.string(),
    language: z.string(),
    ttsModel: z.string(),
    ttsSpeaker: z.string(),
    transferNumber: z.string().optional(),
    temperature: z.number(),
    maxTokens: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const TranscriptTurnSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    text: z.string(),
    lang: z.string().optional(),
    at: z.string(),
  })
  .passthrough();

const CallSchema = z
  .object({
    id: z.string().min(1),
    callSid: z.string().optional(),
    streamSid: z.string().optional(),
    accountSid: z.string().optional(),
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    direction: z.enum(["inbound", "outbound"]),
    from: z.string().optional(),
    to: z.string().optional(),
    status: z.enum([
      "initiated",
      "ringing",
      "answered",
      "in-progress",
      "completed",
      "failed",
      "no-answer",
      "ended",
    ]),
    startedAt: z.string(),
    answeredAt: z.string().optional(),
    endedAt: z.string().optional(),
    durationSec: z.number().optional(),
    recordingUrl: z.string().optional(),
    transcript: z.array(TranscriptTurnSchema),
    customParameters: z.record(z.unknown()).optional(),
    notes: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const NumberSchema = z
  .object({
    id: z.string().min(1),
    number: z.string().min(1),
    label: z.string().optional(),
    agentId: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const SettingsSchema = z
  .object({
    defaultAgentId: z.string().optional(),
    updatedAt: z.string(),
  })
  .passthrough();

const DBExportSchema = z.object({
  agents: z.array(AgentSchema),
  calls: z.array(CallSchema).default([]),
  numbers: z.array(NumberSchema).default([]),
  settings: SettingsSchema.optional(),
});

adminRouter.get("/export", (_req, res) => {
  res.setHeader("Content-Disposition", "attachment; filename=db-export.json");
  res.json(db.exportAll());
});

// Body parsed here, not by the global 1mb parser (server.ts skips this path):
// a full export with 5000 calls + transcripts easily exceeds 1mb.
adminRouter.post("/import", json({ limit: "50mb" }), (req, res) => {
  const parsed = DBExportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "expected a full DB export (agents/calls/numbers/settings)",
      details: parsed.error.flatten(),
    });
  }
  const data = parsed.data;
  db.importAll({
    agents: data.agents,
    calls: data.calls,
    numbers: data.numbers,
    settings: data.settings ?? { updatedAt: new Date().toISOString() },
  } as DBShape);
  void warmAllGreetings(); // pre-synthesize greetings/fillers for imported agents
  res.json({
    ok: true,
    agents: data.agents.length,
    calls: data.calls.length,
    numbers: data.numbers.length,
  });
});
