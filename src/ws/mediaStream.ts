import type { RawData, WebSocket } from "ws";
import { Conversation } from "../agent/conversation";
import { bus } from "../events";
import { logger } from "../logger";
import { db } from "../store/db";
import type { CallDirection } from "../store/types";

const log = logger.child({ mod: "media-stream" });

function nowIso() {
  return new Date().toISOString();
}

/**
 * Handle one VoiceLink WebSocket "bot" connection = one phone call.
 * Protocol events: connected, start, media, mark, dtmf, stop.
 */
export function attachMediaStream(ws: WebSocket): void {
  let conv: Conversation | null = null;
  let callId: string | null = null;
  let loggedFirstMedia = false;

  const send = (obj: unknown) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (err) {
        log.error({ err }, "ws send failed");
      }
    }
  };

  ws.on("message", (raw: RawData) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore non-JSON / binary
    }
    switch (msg.event) {
      case "connected":
        log.info("voicelink connected");
        break;
      case "start":
        handleStart(msg).catch((err) => log.error({ err }, "start handling failed"));
        break;
      case "media": {
        const media = msg.media || {};
        if (!loggedFirstMedia) {
          loggedFirstMedia = true;
          const len = media.payload ? Buffer.from(media.payload, "base64").length : 0;
          log.info({ callId, track: media.track, bytes: len }, "first inbound media frame");
        }
        // Only feed the caller's inbound track into the agent.
        if (media.payload && (media.track === undefined || media.track === "inbound")) {
          conv?.onInboundAudio(media.payload);
        }
        break;
      }
      case "mark":
        if (msg.mark?.name) conv?.onMark(msg.mark.name);
        break;
      case "dtmf":
        log.info({ digit: msg.dtmf?.digit }, "dtmf");
        break;
      case "stop":
        conv?.onStop();
        finalizeEnded();
        break;
      default:
        log.debug({ event: msg.event }, "unhandled event");
    }
  });

  ws.on("close", () => {
    conv?.close();
    finalizeEnded();
  });
  ws.on("error", (err) => log.error({ err }, "ws error"));

  async function handleStart(msg: any): Promise<void> {
    const s = msg.start || {};
    const streamSid: string = msg.stream_sid || s.stream_sid || "";
    const custom: Record<string, unknown> = s.custom_parameters || {};
    const from: string | undefined = s.from;
    const to: string | undefined = s.to;
    const callSid: string | undefined = s.call_sid;
    const accountSid: string | undefined = s.account_sid;

    const agentIdParam = typeof custom.agent_id === "string" ? custom.agent_id : undefined;
    const callRef = typeof custom.call_ref === "string" ? custom.call_ref : undefined;

    const agent = db.resolveAgent({ agentId: agentIdParam, did: to });

    // Link to an existing (outbound-triggered) call, else create a new record.
    let call = callRef ? db.getCall(callRef) : undefined;
    if (!call && callSid) call = db.getCallByCallSid(callSid);

    if (!call) {
      const direction = inferDirection(custom, to, from);
      call = db.createCall({
        direction,
        from,
        to,
        callSid,
        streamSid,
        accountSid,
        agentId: agent?.id,
        agentName: agent?.name,
        status: "in-progress",
        answeredAt: nowIso(),
        customParameters: custom,
      });
      bus.emitEvent({ type: "call.created", call });
    } else {
      db.updateCall(call.id, {
        callSid: callSid ?? call.callSid,
        streamSid,
        accountSid: accountSid ?? call.accountSid,
        status: "in-progress",
        agentId: call.agentId ?? agent?.id,
        agentName: call.agentName ?? agent?.name,
        from: call.from ?? from,
        to: call.to ?? to,
        answeredAt: call.answeredAt ?? nowIso(),
        customParameters: { ...(call.customParameters || {}), ...custom },
      });
      bus.emitEvent({ type: "call.updated", call: db.getCall(call.id) });
    }
    callId = call.id;

    if (!agent) {
      log.error({ callId }, "no agent available to handle call");
      db.updateCall(callId, { notes: "no agent configured", status: "failed" });
      return;
    }

    log.info(
      { callId, agent: agent.name, from, to, streamSid, mediaFormat: s.media_format },
      "call started",
    );
    conv = new Conversation({ agent, send, callId });
    await conv.start(streamSid);
  }

  function finalizeEnded(): void {
    if (!callId) return;
    const call = db.getCall(callId);
    if (!call) return;
    if (["completed", "ended", "failed", "no-answer"].includes(call.status)) return;
    const endedAt = nowIso();
    const durationSec = call.answeredAt
      ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(call.answeredAt)) / 1000))
      : undefined;
    db.updateCall(callId, { status: "ended", endedAt, durationSec });
    bus.emitEvent({ type: "call.updated", call: db.getCall(callId) });
  }
}

function inferDirection(
  custom: Record<string, unknown>,
  to?: string,
  from?: string,
): CallDirection {
  const d = String(custom.direction || "").toLowerCase();
  if (d === "inbound" || d === "outbound") return d;
  // If the dialed number (to) is one of our DIDs, it's inbound.
  if (to && db.getNumberByDid(to)) return "inbound";
  if (from && db.getNumberByDid(from)) return "outbound";
  return "inbound";
}
