import { Router } from "express";
import { z } from "zod";
import { bus } from "../events";
import { logger } from "../logger";
import { db } from "../store/db";
import { OutboundNotConfigured, triggerOutbound } from "../voicelink/outbound";

export const callsRouter = Router();
const log = logger.child({ mod: "api-calls" });

callsRouter.get("/", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json(db.listCalls(limit));
});

callsRouter.get("/:id", (req, res) => {
  const call = db.getCall(req.params.id);
  if (!call) return res.status(404).json({ error: "not found" });
  res.json(call);
});

const OutboundInput = z.object({
  to: z.string().min(3).max(40),
  agentId: z.string().optional(),
  did: z.string().max(40).optional(),
  params: z.record(z.unknown()).optional(),
});

/** Trigger an outbound call. */
callsRouter.post("/", async (req, res) => {
  const parsed = OutboundInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { to, agentId, did, params } = parsed.data;

  const agent = agentId ? db.getAgent(agentId) : db.resolveAgent({});
  const call = db.createCall({
    direction: "outbound",
    to,
    from: did,
    status: "initiated",
    agentId: agent?.id,
    agentName: agent?.name,
    customParameters: { agent_id: agent?.id, ...(params || {}) },
  });
  bus.emitEvent({ type: "call.created", call });

  try {
    const result = await triggerOutbound({
      toNumber: to,
      did,
      agentId: agent?.id,
      callRef: call.id,
      extraParams: params,
    });
    const patch = {
      status: result.ok ? ("ringing" as const) : ("failed" as const),
      callSid: result.providerCallId ?? call.callSid,
      notes: result.ok ? undefined : `lead api ${result.status}: ${result.body.slice(0, 200)}`,
    };
    db.updateCall(call.id, patch);
    bus.emitEvent({ type: "call.updated", call: db.getCall(call.id) });
    if (!result.ok) {
      return res.status(502).json({ error: "outbound trigger failed", detail: result, call: db.getCall(call.id) });
    }
    res.status(201).json({ call: db.getCall(call.id), trigger: result });
  } catch (err) {
    db.updateCall(call.id, { status: "failed", notes: (err as Error).message });
    bus.emitEvent({ type: "call.updated", call: db.getCall(call.id) });
    if (err instanceof OutboundNotConfigured) {
      return res.status(400).json({ error: err.message });
    }
    log.error({ err }, "outbound trigger error");
    res.status(500).json({ error: (err as Error).message });
  }
});
