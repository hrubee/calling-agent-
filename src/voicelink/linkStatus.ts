import { bus } from "../events";

/**
 * Live status of the VoiceLink link. VoiceLink opens a WebSocket per call (and
 * for its panel connectivity checks) and posts lifecycle webhooks, so this
 * tracks "is a call live right now" plus "when did VoiceLink last reach us".
 */

export interface VoicelinkLink {
  /** Currently open media-stream WebSockets (≈ live calls). */
  activeConnections: number;
  /** Last time VoiceLink opened the WebSocket (call or panel check). */
  lastConnectedAt: string | null;
  /** Last time a lifecycle webhook arrived. */
  lastWebhookAt: string | null;
}

const status: VoicelinkLink = {
  activeConnections: 0,
  lastConnectedAt: null,
  lastWebhookAt: null,
};

export function getVoicelinkLink(): VoicelinkLink {
  return { ...status };
}

export function markWsConnected(): void {
  status.activeConnections++;
  status.lastConnectedAt = new Date().toISOString();
  emit();
}

export function markWsClosed(): void {
  status.activeConnections = Math.max(0, status.activeConnections - 1);
  emit();
}

export function markWebhookSeen(): void {
  status.lastWebhookAt = new Date().toISOString();
  emit();
}

function emit(): void {
  bus.emitEvent({ type: "voicelink.link", link: getVoicelinkLink() });
}
