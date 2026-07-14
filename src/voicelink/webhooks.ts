import { bus } from "../events";
import { logger } from "../logger";
import { db } from "../store/db";
import type { Call, CallStatus } from "../store/types";
import { markWebhookSeen } from "./linkStatus";

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
  // NO_ANSWER/NOANSWER must be tested before the bare ANSWER substring match.
  if (cs.includes("NO") && cs.includes("ANSWER")) return "no-answer";
  if (cs.includes("ANSWER")) return "answered";
  if (cs.includes("FAIL")) return "failed";
  return undefined;
}

/**
 * Custom parameters arrive camelCase or snake_case depending on the VoiceLink
 * endpoint, and sometimes as a JSON string (the trigger API sends them that way).
 */
function customParams(body: any): Record<string, unknown> | undefined {
  const raw = body?.customParameters ?? body?.custom_parameters;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

function findCall(
  callId: unknown,
  from: unknown,
  to: unknown,
  callRef?: unknown,
  maxAgeMs = 15 * 60 * 1000,
): Call | undefined {
  // Outbound calls we triggered carry our record id back as call_ref.
  if (typeof callRef === "string" && callRef) {
    const byRef = db.getCall(callRef);
    if (byRef) return byRef;
  }
  if (typeof callId === "string" && callId) {
    const byId = db.getCallByCallSid(callId);
    if (byId) return byId;
  }
  const f = norm(from);
  const t = norm(to);
  if (!f && !t) return undefined;
  return db.listCalls(80).find((c) => {
    const age = Date.now() - Date.parse(c.createdAt);
    if (age > maxAgeMs) return false;
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
  markWebhookSeen();
  const event = String(body?.event || "");
  const vlCallId = body?.callId ?? body?.call_id ?? body?.uuid;
  const from = body?.fromNumber ?? body?.from;
  const to = body?.toNumber ?? body?.to;
  const direction = String(body?.direction || "").toLowerCase() === "outbound" ? "outbound" : "inbound";
  const status = mapStatus(event, body?.callStatus);
  const durationSec = body?.duration != null ? Number(body.duration) : undefined;
  const recordingUrl = body?.recordingUrl ?? body?.recording_url;
  const custom = customParams(body);

  log.info({ event, vlCallId, from, to, status }, "webhook received");

  // End-of-call webhooks can arrive long after createdAt (calls longer than the
  // window); keep the fuzzy phone match wide for them so duration/recording land.
  const isFinal =
    status === "ended" || status === "completed" || status === "no-answer" || status === "failed";
  let call = findCall(vlCallId, from, to, custom?.call_ref, isFinal ? 6 * 60 * 60 * 1000 : undefined);

  const patch: Partial<Call> = {};
  if (status) patch.status = status;
  if (durationSec != null && !Number.isNaN(durationSec)) patch.durationSec = durationSec;
  if (recordingUrl) patch.recordingUrl = recordingUrl;
  if (status === "ended" || status === "completed") patch.endedAt = new Date().toISOString();
  if (custom && call) patch.customParameters = { ...(call.customParameters || {}), ...custom };

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
      customParameters: custom,
    });
    bus.emitEvent({ type: "call.created", call });
    return { ok: true, callId: call.id, matched: false };
  } else {
    return { ok: true, matched: false };
  }

  if (call) bus.emitEvent({ type: "call.updated", call });
  return { ok: true, callId: call?.id, matched: true };
}
