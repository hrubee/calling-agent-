# 📞 Calling Agent — Sarvam AI × VoiceLink

A production AI phone-calling agent. **VoiceLink** provides the telephony (phone
numbers, dialing, live call audio over WebSocket); **Sarvam AI** provides the
brain (speech-to-text, LLM, text-to-speech). It answers inbound calls, places
outbound calls, holds a real-time multilingual voice conversation with barge-in,
and ships with a web dashboard to manage agents, watch calls live, and launch
calls. Deploys to **Railway**.

---

## How it works

```
 Caller ⇄ VoiceLink (PSTN + SIP)  ──WSS media-stream──▶  THIS SERVICE  ──▶  Sarvam AI
                                                          │  a-law 8k audio │   STT (saaras)
   VoiceLink dials / answers, streams a-law 8k audio      │  ⇅ conversation │   Chat (LLM)
   and fires lifecycle webhooks                           │     engine      │   TTS (bulbul, a-law 8k)
                                                          ▼
                                                   Dashboard + JSON API
```

Per call the engine: decodes inbound **a-law 8 kHz** audio → energy **VAD**
segments an utterance → **Sarvam STT** (auto language detect) → **Sarvam Chat**
(streamed) → **Sarvam TTS** emitted directly as **a-law 8 kHz** (VoiceLink's
exact wire format, no transcoding) → streamed back as `media` frames, with
**barge-in** (`clear`) so the caller can interrupt.

### VoiceLink WebSocket protocol (implemented)
- Inbound events: `connected`, `start` (call metadata + `custom_parameters`), `media` (`track:"inbound"`, base64 a-law), `mark` echo, `stop`.
- We send: `media` (a-law), `mark`, `clear` (barge-in), `transfer` (hand-off to a human number).
- Lifecycle webhooks (`call.initiated/answered/ended/completed`) update call status, duration, and recording URL.

---

## Project layout

```
src/
  index.ts            HTTP + WebSocket server bootstrap
  server.ts           Express app: dashboard, API, auth, webhook
  config.ts           env parsing + generated secrets
  audio/              g711 (a-law), resample, wav, vad  (pure JS, no native deps)
  sarvam/             client, stt, tts, chat (streaming), doctor
  agent/              prompt + conversation engine (STT→LLM→TTS, barge-in)
  ws/mediaStream.ts   VoiceLink bot protocol handler
  voicelink/          webhooks (lifecycle) + outbound (env-configurable Lead API)
  store/              JSON-file store (agents, calls, numbers, settings)
  api/                agents, calls, numbers, settings, events (SSE), auth
public/               vanilla dashboard (index.html, app.js, styles.css)
scripts/              doctor.ts, mock-voicelink.ts
tests/                audio codec + VAD unit tests
```

---

## Quick start (local)

```bash
cp .env.example .env
#   set SARVAM_API_KEY, DASHBOARD_PASSWORD, WSS_TOKEN, WEBHOOK_TOKEN, SESSION_SECRET
npm install
npm run doctor      # verifies Sarvam STT/LLM/TTS and tells you the working chat model
npm run dev         # starts on http://localhost:8080
```

Open `http://localhost:8080`, sign in with `DASHBOARD_PASSWORD`.

Simulate a real call without a phone (set a fixed `WSS_TOKEN` in `.env` first):

```bash
npm run mock-call "Hi, what are your opening hours?"
```

You should see the bot's audio frames + `response_done` mark, and the call
(with transcript) appear live in the dashboard's **Calls** tab.

Run unit tests:

```bash
npm test
```

---

## Configuration

All config is environment-driven — see [`.env.example`](./.env.example). Highlights:

| Var | Purpose |
| --- | --- |
| `SARVAM_API_KEY` | Sarvam key (required for STT/LLM/TTS). |
| `SARVAM_CHAT_MODEL` | LLM model. Candidates: `sarvam-m`, `sarvam-30b`, `sarvam-105b`. `npm run doctor` tells you which responds. |
| `SARVAM_TTS_MODEL` / `SARVAM_TTS_SPEAKER` | Voice, e.g. `bulbul:v2` / `anushka`. |
| `DEFAULT_LANGUAGE` | `auto` (detect per utterance) or a BCP-47 code. |
| `DASHBOARD_PASSWORD` | Admin login for the dashboard + API. |
| `WSS_TOKEN` / `WEBHOOK_TOKEN` | Shared secrets embedded in the URLs you give VoiceLink. |
| `VOICELINK_LEAD_*` | Outbound "Add Lead / trigger call" API (see below). |
| `DATA_DIR` | Where the JSON store lives (a Railway volume in prod). |

Any secret left blank is auto-generated at boot and printed to the logs (fine
for local dev; **always set them explicitly in production**).

### Outbound calling (VoiceLink Lead API)

VoiceLink's outbound-trigger endpoint is documented **inside your VoiceLink panel**
(API Documentation section), so it's wired up via env. Copy the values from the
panel into:

```
VOICELINK_LEAD_API_URL=...              # the endpoint
VOICELINK_LEAD_API_KEY=...              # your key
VOICELINK_LEAD_AUTH_STYLE=bearer        # bearer | header | query | none
VOICELINK_LEAD_METHOD=POST
VOICELINK_LEAD_FIELD_PHONE=customer_number   # body/query field for the destination number
VOICELINK_LEAD_FIELD_DID=did_number          # field for the DID to dial from
VOICELINK_LEAD_EXTRA_JSON={}                 # any extra static fields the API needs
```

Inbound calls work immediately after panel wiring; outbound activates once these
are set. The app passes `agent_id` and `call_ref` in the lead's custom parameters
so the call links back to the right agent and record.

---

## Deploy to Railway

The repo includes a `Dockerfile` and `railway.json`.

```bash
railway login                     # opens a browser (run `! railway login` inside Claude Code)
railway init                      # or `railway link` to an existing project
railway volume add --mount-path /data   # persistent store for call logs/agents
railway variables --set SARVAM_API_KEY=... --set DASHBOARD_PASSWORD=... \
  --set WSS_TOKEN=... --set WEBHOOK_TOKEN=... --set SESSION_SECRET=... \
  --set APP_BASE_URL=https://call.radianmedia.org --set DATA_DIR=/data
railway up                        # build + deploy
railway domain call.radianmedia.org   # then add the shown CNAME to your DNS
```

Then in the **Settings** tab of the dashboard, copy the **WSS URL** and
**Webhook URL** into the VoiceLink panel:
- VoiceLink → **WebSocket Bot** → WSS URL = `wss://call.radianmedia.org/media-stream?token=<WSS_TOKEN>`, Webhook URL = `https://call.radianmedia.org/webhooks/voicelink?token=<WEBHOOK_TOKEN>`.
- VoiceLink → **Call Routing** → route your DID to that WebSocket Bot.

Health check: `GET /healthz`.

---

## Notes & limitations
- STT is batch-per-utterance (Sarvam has no public streaming STT WS); latency is one STT+LLM+TTS round trip per turn, reduced by sentence-chunked TTS.
- The JSON store is single-instance. For horizontal scale, swap `src/store/db.ts` for Postgres (repository interface is already isolated).
- Audio format assumed a-law 8 kHz mono per VoiceLink docs; TTS output has its container header stripped defensively.
