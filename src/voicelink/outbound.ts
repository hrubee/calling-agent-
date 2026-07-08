import { config } from "../config";
import { fetchWithTimeout } from "../sarvam/client";

export interface OutboundParams {
  toNumber: string;
  did?: string;
  agentId?: string;
  callRef?: string;
  extraParams?: Record<string, unknown>;
}

export interface OutboundResult {
  ok: boolean;
  status: number;
  body: string;
  providerCallId?: string;
}

export class OutboundNotConfigured extends Error {
  constructor() {
    super(
      "Outbound calling is not configured. Set VOICELINK_LEAD_API_URL (and related VOICELINK_LEAD_* vars) from your VoiceLink panel > API Documentation.",
    );
    this.name = "OutboundNotConfigured";
  }
}

/**
 * Trigger an outbound call through VoiceLink's "Add Lead / trigger call" API.
 * The exact endpoint lives behind the VoiceLink panel login, so everything here
 * is driven by env (URL, method, auth style, field names, extra static fields).
 */
export async function triggerOutbound(p: OutboundParams): Promise<OutboundResult> {
  const cfg = config.voicelink.lead;
  if (!cfg.configured) throw new OutboundNotConfigured();

  const params: Record<string, unknown> = {
    ...(p.agentId ? { agent_id: p.agentId } : {}),
    ...(p.callRef ? { call_ref: p.callRef } : {}),
    ...(p.extraParams || {}),
  };

  const headers: Record<string, string> = { Accept: "application/json" };
  let url = cfg.url;

  // Auth
  if (cfg.authStyle === "bearer") {
    headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  } else if (cfg.authStyle === "header") {
    headers[cfg.authName || "Authorization"] = cfg.apiKey;
  } else if (cfg.authStyle === "query") {
    url = appendQuery(url, cfg.authName || "api_key", cfg.apiKey);
  }

  const method = cfg.method || "POST";
  let init: RequestInit;

  if (method === "GET") {
    url = appendQuery(url, cfg.fieldPhone, p.toNumber);
    if (p.did) url = appendQuery(url, cfg.fieldDid, p.did);
    if (cfg.fieldParams && Object.keys(params).length)
      url = appendQuery(url, cfg.fieldParams, JSON.stringify(params));
    for (const [k, v] of Object.entries(cfg.extra || {})) url = appendQuery(url, k, String(v));
    init = { method, headers };
  } else {
    const bodyObj: Record<string, unknown> = {
      ...(cfg.extra || {}),
      [cfg.fieldPhone]: p.toNumber,
    };
    if (p.did) bodyObj[cfg.fieldDid] = p.did;
    if (cfg.fieldParams && Object.keys(params).length) bodyObj[cfg.fieldParams] = params;
    headers["Content-Type"] = "application/json";
    init = { method, headers, body: JSON.stringify(bodyObj) };
  }

  const res = await fetchWithTimeout(url, init, 20000);
  const text = await res.text();

  let providerCallId: string | undefined;
  try {
    const json = JSON.parse(text);
    providerCallId =
      json.callId ?? json.call_id ?? json.id ?? json.uuid ?? json.data?.callId ?? json.data?.id;
    if (providerCallId != null) providerCallId = String(providerCallId);
  } catch {
    /* non-JSON response */
  }

  return { ok: res.ok, status: res.status, body: text.slice(0, 2000), providerCallId };
}

function appendQuery(url: string, key: string, value: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}
