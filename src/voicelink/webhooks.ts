import { bus } from "../events";
import { logger } from "../logger";
import { db } from "../store/db";
import type { Call, CallStatus } from "../store/types";

const log = logger.child({ mod: "voicelink-webhook" });

const norm = (s: unknown) => String(s ?? "").replace(/\D/g, "");

/** Map a VoiceLink lifecycle event to our internal call status. */
function mapStatus(event: string, callStatus?: string): CallStatus | undefined {
  switch (event) {
    case "call.initiated":
      return "initiated";
    case "call.answered":
      return "answered";
    case "call.ended":
      return "ended";
    case "call.completed":
      return "completed";
  }
  const cs = String(callStatus || "").toUpperCase();
  if (cs.includes("ANSWER")) return "answered";
  if (cs.includes("FAIL")) return "failed";
  if (cs.includes("NO") && cs.includes("ANSWER")) return "no-answer";
  return undefined;
}

function findCall(callId: unknown, from: unknown, to: unknown): Call | undefined {
  if (typeof callId === "string" && callId) {
    const byId = db.getCallByCallSid(callId);
    if (byId) return byId;
  }
  const f = norm(from);
  const t = norm(to);
  if (!f && !t) return undefined;
  return db.listCalls(80).find((c) => {
    const age = Date.now() - Date.parse(c.createdAt);
    if (age > 15 * 60 * 1000) return false;
    const cf = norm(c.from);
    const ct = norm(c.to);
    return (cf === f && ct === t) || (cf === t && ct === f);
  });
}

export interface WebhookResult {
  ok: boolean;
  callId?: string;
  matched: boolean;
}

/**
 * Process a VoiceLink lifecycle webhook (call.initiated/answered/ended/completed).
 * Updates or creates the matching call record and pushes a live update.
 */
export function handleVoicelinkWebhook(body: any): WebhookResult {
  const event = String(body?.event || "");
  const vlCallId = body?.callId ?? body?.call_id ?? body?.uuid;
  const from = body?.fromNumber ?? body?.from;
  const to = body?.toNumber ?? body?.to;
  const direction = String(body?.direction || "").toLowerCase() === "outbound" ? "outbound" : "inbound";
  const status = mapStatus(event, body?.callStatus);
  const durationSec = body?.duration != null ? Number(body.duration) : undefined;
  const recordingUrl = body?.recordingUrl ?? body?.recording_url;

  log.info({ event, vlCallId, from, to, status }, "webhook received");

  let call = findCall(vlCallId, from, to);

  const patch: Partial<Call> = {};
  if (status) patch.status = status;
  if (durationSec != null && !Number.isNaN(durationSec)) patch.durationSec = durationSec;
  if (recordingUrl) patch.recordingUrl = recordingUrl;
  if (status === "ended" || status === "completed") patch.endedAt = new Date().toISOString();
  if (body?.customParameters && typeof body.customParameters === "object") {
    call && (patch.customParameters = { ...(call.customParameters || {}), ...body.customParameters });
  }

  if (call) {
    // Don't downgrade a live/completed call back to "initiated".
    if (patch.status === "initiated" && call.status !== "initiated") delete patch.status;
    db.updateCall(call.id, patch);
    call = db.getCall(call.id);
  } else if (event === "call.initiated" || event === "call.answered") {
    // Track a call we haven't seen on the WSS side yet.
    call = db.createCall({
      direction,
      from: from ? String(from) : undefined,
      to: to ? String(to) : undefined,
      callSid: typeof vlCallId === "string" ? vlCallId : undefined,
      status: status ?? "initiated",
      customParameters: body?.customParameters,
    });
    bus.emitEvent({ type: "call.created", call });
    return { ok: true, callId: call.id, matched: false };
  } else {
    return { ok: true, matched: false };
  }

  if (call) bus.emitEvent({ type: "call.updated", call });
  return { ok: true, callId: call?.id, matched: true };
}
