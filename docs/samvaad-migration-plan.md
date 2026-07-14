# Sarvam Samvaad migration plan

**Status:** decision-ready draft · researched 2026-07-14 · task `voice calling-d709`

**Question:** should we move the voice-calling agent off the custom VoiceLink + Sarvam-API stack onto **Sarvam Samvaad**, Sarvam's managed conversational-voice platform?

**Driver:** `sarvam-30b` on the public chat API spends ~5–10 s "reasoning" before the first content token, and this cannot be disabled (`reasoning_effort=low`, `enable_thinking:false`, `/no_think` all still reason; verified by live probes on 2026-07-09 and re-verified 2026-07-14). That delay is unacceptable on a live call. Samvaad claims sub-500 ms interactions on private serving.

**TL;DR recommendation (details in §6):** do both tracks in parallel —
1. **Today:** set a fast-LLM key (`CHAT_LLM_*`) in prod. The bridge is already shipped; this alone takes turns from ~6–10 s to an estimated ~1–1.5 s and removes all schedule pressure from the migration.
2. **This week:** log into `platform.sarvam.ai`, build a pilot Marathi agent on free credits, and resolve the four blocking unknowns (telephony path, real latency, per-minute price, voice/handoff parity). Migrate only if all four pass; otherwise stay on custom+bridge. Do **not** build the "bridge VoiceLink WS audio into Samvaad" hybrid — no public API exists for it.

Everything below is grounded with a source link. Claims we could not verify are flagged **[VERIFY]**. Nothing here is a fabricated endpoint or price.

---

## 1. What Samvaad is, and how to get access

**What it is.** Sarvam Samvaad is Sarvam AI's managed conversational-AI platform: you configure an agent (instructions, knowledge base, tools/CRM integrations) and it runs the whole STT → LLM → TTS loop for you, with interruption handling, analytics, and multi-channel delivery. Confirmed capabilities from Sarvam's own materials:

- Voice + chat agents in **11 languages** — Hindi, Tamil, Telugu, Bengali, **Marathi**, Gujarati, Kannada, Malayalam, Punjabi, Odia, English ([product page](https://www.sarvam.ai/products/conversational-agents), [AWS Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio)).
- Channels: **telephone (inbound + outbound, "low latency and interruption handling")**, **WhatsApp (text, voice notes, and voice calls)**, **web and mobile apps** via JS / React Native / Flutter SDKs ([AWS listing](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio), [Sarvam launch post on X](https://x.com/SarvamAI/status/1932013070064193666)).
- "Responds in under one second", handles interruptions, colloquial speech, alphanumerics ([AWS listing](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio)); press coverage repeats a **sub-500 ms** figure ([Let's Data Science](https://letsdatascience.com/news/sarvam-ai-opens-voice-agents-platform-to-public-a32ad441)). See §5 for the reality-check.
- Underlying LLM is reported to be **sarvam-30b served privately** ("Sarvam 30B powers Samvaad", [explainx.ai guide](https://explainx.ai/blog/sarvam-ai-capabilities-api-models-guide-2026) — third-party claim, **[VERIFY]**). This matters: it's the same model we're fleeing, minus the public-API reasoning delay. The latency win is real only if their private serving suppresses reasoning; that is only testable with a live pilot call.

**Access.** Two routes exist as of July 2026:

| Route | Evidence | Fit for us |
|---|---|---|
| **Self-serve** — Samvaad opened to the public ~June 8 2026 with "a self-serve model with free credits and usage-based pricing" | [Elets BFSI](https://bfsi.eletsonline.com/sarvam-ai-opens-voice-ai-platform-sarvam-samvaad-to-public-targets-wider-adoption/), [Inc42](https://inc42.com/buzz/exclusive-sarvam-ai-to-open-voice-ai-agents-platform-for-public-use/) | ✅ This is our route. |
| **Enterprise** — AWS Marketplace SaaS contract, 12-month term, priced per "60 Second Pulse" (listed figure $575,000/contract-year; unit ambiguous), contact partnerships@sarvam.ai | [AWS Marketplace](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio) | ❌ Not at our scale; useful as a signal that telephony/WhatsApp channels are production-real. |

Concretely for us: the existing **dashboard.sarvam.ai account is the entry point** — `dashboard.sarvam.ai/agents` now 308-redirects to **`platform.sarvam.ai/agents`** (verified by fetch on 2026-07-14; the page itself blocks anonymous access, so what's inside the Agents tab — waitlist vs. immediate builder — is **[VERIFY]** on first login). If the Agents tab is gated for our account despite the public launch, fall back to the "Talk to us" form on the [product page](https://www.sarvam.ai/products/conversational-agents) or partnerships@sarvam.ai (from the AWS listing).

**Documentation caveat:** `docs.sarvam.ai` has **no Samvaad platform docs at all** — its [llms.txt index](https://docs.sarvam.ai/llms.txt) covers only raw APIs and DIY voice-agent guides (LiveKit, Pipecat). Expect Samvaad's real docs (telephony setup, pricing, SDKs) to live inside the platform after login. Note the DIY guides are *not* an escape hatch from our latency problem: the LiveKit `sarvam.LLM` plugin wraps the same public `api.sarvam.ai/v1` and inherits the identical reasoning delay (verified from plugin source, 2026-07-14).

## 2. Telephony: how calls would reach Samvaad

Current wiring, for reference: a VoiceLink DID delivers inbound calls; VoiceLink pushes lifecycle webhooks to `/webhooks/voicelink` and opens a WebSocket to `/media-stream` speaking a Twilio-media-streams-style protocol (`connected/start/media/mark/dtmf/stop`, base64 A-law 8 kHz, `custom_parameters` for agent routing) — see `src/ws/mediaStream.ts`, `src/voicelink/webhooks.ts`. Outbound is triggered through VoiceLink's "add lead" API (`src/voicelink/outbound.ts`; the API key for it was never obtained, so outbound has never worked in prod).

What Samvaad supports on the ingress side is the **single biggest unknown** — no public doc names SIP, PSTN mechanics, or telco partners for the self-serve tier. What we do know:

- The telephone channel itself (inbound + outbound) is officially confirmed ([AWS listing](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio), [Sarvam on X](https://x.com/SarvamAI/status/1932013070064193666)).
- **Exotel is Sarvam's production telephony backbone** — Exotel's own blog describes Sarvam running national-scale voice-AI rollouts on Exotel infrastructure with embedded Exotel engineers ([Exotel blog](https://exotel.com/blog/voice-ai-india-infrastructure-exotel/)). So the platform's native path is most likely Exotel-backed numbers provisioned in-platform, or a connect-your-Exotel-account flow. **[VERIFY]** in-platform.
- **VoiceLink supports SIP, WebSocket, WebRTC and PSTN connectivity** on its side ([voicelink.co.in](https://voicelink.co.in/)), so forwarding away from the current DID is technically plausible — *if* Samvaad exposes an ingress.

### Option A — keep VoiceLink DID, bridge WS audio into Samvaad

Our server stays in the media path and proxies VoiceLink's WS frames into Samvaad. **Not viable today: there is no documented Samvaad API for raw media-stream ingress.** The only programmatic surfaces mentioned anywhere are the JS/React Native/Flutter *client* SDKs ([AWS listing](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio)); abusing the web SDK as a headless telephony bridge would be unsupported, add a hop of latency, break DTMF/caller-ID semantics, and keep alive exactly the plumbing we want to delete. Only reconsider if the in-platform docs reveal a real media/SIP ingress API. **Recommendation: reject unless in-platform docs say otherwise.**

### Option B — keep VoiceLink DID, forward calls to Samvaad

Two sub-variants, in order of preference:

- **B1: SIP forward.** VoiceLink advertises SIP connectivity; if Samvaad (or its Exotel backbone) accepts an inbound SIP trunk, the existing DID keeps working and our server drops out of the call path entirely. Both halves are **[VERIFY]**: whether VoiceLink's panel actually offers "forward this DID to an external SIP URI" (their site says SIP-capable, not that this specific feature is self-serve), and whether Samvaad exposes SIP ingress at all.
- **B2: PSTN call-forward.** VoiceLink DID simply forwards to a Samvaad-provisioned phone number. Almost certainly works if Samvaad provisions numbers, but you pay two telcos per minute, add PSTN-hop latency, and the caller's number may arrive as the forwarding DID rather than the real caller (CLI passthrough on Indian virtual numbers is unreliable). Acceptable as a *transition* trick to keep the published number alive, not as the end state.

### Option C — Samvaad-native telephony (new number or ported number)

Provision the number where Samvaad expects it (in-platform, likely Exotel-backed — see above). Cleanest architecture: zero custom media code, one vendor for the whole voice loop, and the officially supported path. Costs: the published phone number changes (porting a virtual DID between Indian cloud-telephony providers is generally not practical — **[VERIFY]** only if number continuity is a hard requirement), plus whatever the platform charges for numbers/minutes (§5). The never-solved VoiceLink outbound API-key problem disappears too, since outbound becomes a platform feature.

### Option D — WhatsApp voice as a channel, skipping PSTN entirely

Samvaad supports voice calling inside WhatsApp threads ([Sarvam on X, Sept 2025](https://x.com/SarvamAI/status/1963548479500030279)). If the use-case tolerates "call us on WhatsApp" instead of a phone number, this sidesteps DIDs and telcos completely. Requires a WhatsApp Business number and Meta approval flow. Worth piloting alongside C. **[VERIFY]** availability on the self-serve tier.

**Bottom line:** C is the architectural target; B2 is the bridge that preserves the current number during transition; A is rejected; D is opportunistic. The first platform session must answer: *does Samvaad provision numbers, connect an Exotel account, or accept SIP?* — that answer picks between B and C.

## 3. What survives, what dies

Repo today: ~4,800 lines of TypeScript + a ~800-line vanilla-JS dashboard (`public/`). If Samvaad owns the STT→LLM→TTS loop, the entire real-time pipeline — roughly **60% of the codebase, including everything we sweated over in the last two weeks** — becomes dead weight:

| Component | Files (lines) | Full migration (C) | Hybrid B2 (forward, keep dashboard) | Stay custom+bridge |
|---|---|---|---|---|
| Conversation engine / turn loop | `src/agent/conversation.ts` (608) | ☠️ dies | ☠️ dies | ✅ core |
| VAD, barge-in, speculative STT | `src/audio/vad.ts` (137) + logic in conversation.ts | ☠️ dies (Samvaad does interruption handling) | ☠️ dies | ✅ core |
| Audio codecs/resampling | `src/audio/g711.ts`, `resample.ts`, `wav.ts` (175) | ☠️ dies | ☠️ dies | ✅ core |
| Streaming TTS over Sarvam WS | `src/sarvam/ttsStream.ts` (165), `tts.ts` (66) | ☠️ dies | ☠️ dies | ✅ shipped 07-14, works |
| Fast-LLM bridge | `src/llm/chat.ts` (105), `src/sarvam/chat.ts` (112) | ☠️ dies | ☠️ dies | ✅ **the latency fix** |
| STT client | `src/sarvam/stt.ts` (55) | ☠️ dies | ☠️ dies | ✅ core |
| Greeting/filler cache | `src/agent/greeting.ts` (75) | ☠️ dies (no dead-air to mask) | ☠️ dies | ✅ core |
| System-prompt builder | `src/agent/prompt.ts` (27) | ➡️ content ports to Samvaad builder (§4) | ➡️ ports | ✅ |
| VoiceLink WS media endpoint | `src/ws/mediaStream.ts` (174) | ☠️ dies | ☠️ dies | ✅ core |
| VoiceLink webhooks + link status | `src/voicelink/webhooks.ts` (104), `linkStatus.ts` (46) | ☠️ dies | 🤔 keep only if VoiceLink stays as forwarder and we want lifecycle logs | ✅ |
| VoiceLink outbound (add-lead) | `src/voicelink/outbound.ts` (103) | ☠️ dies (platform outbound; also never worked — key missing) | ☠️ dies | ⚠️ still blocked on key |
| Dashboard + call store + REST API | `public/` (~800), `src/api/*` (~350), `src/store/db.ts` (289) | 🕯️ superseded — Samvaad has its own analytics/call logs ([AWS listing](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio)); keep read-only as the archive of historical calls | ✅ survives as our pane of glass | ✅ core |
| Admin export/import | `src/api/admin.ts` (29) | ✅ **survives — it's the migration tool** (§4) | ✅ | ✅ |
| Config/env plumbing | `src/config.ts` (202), `index.ts`, `server.ts`, `logger.ts`, `events.ts` | mostly dies | shrinks | ✅ |
| Railway deployment | `Dockerfile`, `railway.json` | 🕯️ decommission after cut-over (and the wedged-volume saga ends by deletion) | ✅ needed | ⚠️ volume still wedged |

Sunk-cost warning, stated honestly: the streaming-TTS and fast-LLM-bridge work shipped on 2026-07-14 is *exactly* the part Samvaad replaces. That is not a reason to avoid Samvaad (sunk cost), but it *is* a reason the "stay custom" option is stronger than it was a week ago — the custom stack's remaining latency problem is one env var away from fixed (§5).

Under **full migration**, nothing in this repo runs in the call path. The repo's end state is: archived dashboard + call-history JSON export, kept as fallback until Samvaad has survived ≥1 week of production traffic.

## 4. Porting the live agent config

The live agent lives in the JSON store on the Railway volume, **not in git** — and the Railway volume is currently unmounted (staged-changes queue wedged), meaning **prod data resets on every deploy**. So step zero, before any migration or deploy:

```
GET https://calling-agent-production-d954.up.railway.app/api/admin/export   (dashboard auth)
```

and keep the `db-export.json` somewhere durable. (`src/api/admin.ts` implements this; import restores via `POST /api/admin/import`.)

What ports, per the `Agent` schema (`src/store/types.ts`):

| Our field | Live value | Samvaad equivalent |
|---|---|---|
| `name` | `मराठी सहाय्यक` | Agent name — direct. |
| `language` | `mr-IN` | Marathi is one of Samvaad's 11 languages ([product page](https://www.sarvam.ai/products/conversational-agents)) — direct. |
| `systemPrompt` | (in the export; persona text) | Samvaad "conversational instructions". Port **only the persona part**. Do *not* port the boilerplate `buildSystemPrompt()` appends (`src/agent/prompt.ts`): "keep replies short", "no markdown, read aloud by TTS", language-lock, and the `[[TRANSFER]]` token protocol — those exist to discipline a raw LLM into phone behavior. Samvaad handles voice register natively; re-adding our TTS disclaimers would at best be noise. **[VERIFY]** how Samvaad configures human/agent transfer and use its native mechanism instead of the token. |
| `greeting` | (in the export) | Agent greeting/opening message — direct. |
| `ttsModel` / `ttsSpeaker` | `bulbul:v3` / `priya` | Samvaad uses Sarvam's own TTS, so bulbul voices should exist, but the platform's voice picker is unverified — **[VERIFY]** that speaker "priya" is selectable; if not, re-run the voice-picker comparison to choose the closest Marathi voice. |
| `temperature`, `maxTokens` | (export) | Probably not exposed; accept platform defaults. |
| Filler config (`हम्म.`, 900 ms delay) | env | **Drop.** Fillers exist to mask the 5–10 s reasoning gap; on a sub-second platform they're pointless. |
| DID → agent mapping (`numbers`) | store | Recreated in whatever telephony flow §2 lands on. |

Porting effort is trivial (one agent, one number, copy-paste of a prompt) — a 30-minute task once platform access and telephony are resolved. The pilot agent should be a *copy*, leaving the live custom stack untouched until cut-over.

## 5. Cost + latency reality-check

### Latency

| Stack | First-audio latency | Source / confidence |
|---|---|---|
| Current prod (Sarvam chat, sarvam-30b) | **~6–10 s** (LLM first content 5–10 s, irreducible; TTS ~0.47 s after first token) | Our measured "turn latency" logs; live probes 2026-07-09 and 07-14. High confidence. |
| Current stack + fast-LLM bridge (e.g. Gemini Flash) | **~1–1.5 s estimated** (bridge + streaming TTS shipped and verified in prod; missing only a `CHAT_LLM_API_KEY`) | Our own measurement of the TTS leg + typical Flash first-token times. Medium confidence until the key is in. |
| Samvaad — marketing | **"sub-500 ms" / "under one second"** | [Press](https://letsdatascience.com/news/sarvam-ai-opens-voice-agents-platform-to-public-a32ad441) / [AWS listing](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio). Claims, not measurements. |
| Samvaad — realistic expectation | **~0.8–1.8 s** | Independent test of Sarvam's voice pieces measured 1.2–1.8 s unoptimized, ~800 ms projected optimized, streaming first-audio 300–400 ms ([GrowwStacks](https://growwstacks.com/blog/sarvam-ai-tts-stt-voice-agent-test) — DIY stack, not Samvaad itself, so imperfect proxy). Sarvam's IVR-page latency claims already failed to hold on the public chat API when we probed it, so treat marketing numbers skeptically until we place a real pilot call. **[VERIFY with a stopwatch on a pilot call.]** |

Two honest conclusions. First, the *only* thing that credibly gets Samvaad under a second is private serving of sarvam-30b without the reasoning phase — which is precisely the thing we cannot inspect and must measure. Second, **the custom stack with a fast-LLM key is likely within ~0.5 s of realistic Samvaad latency**, so latency alone no longer forces this migration; the stronger arguments for Samvaad are operational (no Railway volume saga, no VAD/barge-in code to maintain, native outbound, WhatsApp channel, vendor-supported telephony).

### Cost

Current stack, per talk-minute, from the [official API price list](https://docs.sarvam.ai/api/pricing.md) (fetched 2026-07-14):

- STT `saaras`: ₹30/hour billed per second → **≤ ₹0.50/min** (we only send utterances, so effectively less).
- TTS `bulbul:v3`: ₹30/10K chars; agent speaks roughly half the call at ~800 chars/min of speech → **~₹1.0–1.5/min**. (Estimate; arithmetic, not a quoted price.)
- LLM `sarvam-30b`: ₹2.5 in / ₹10 out per **1M** tokens — even with 2k wasted reasoning tokens per turn this is **~₹0.02/turn, negligible**. (Cost was never the problem with sarvam-30b; latency was. A Gemini Flash free-tier key keeps the bridge at ₹0.)
- VoiceLink telephony: **pricing not public** (panel-only) — **[VERIFY]** from the panel invoice; typical Indian cloud-telephony inbound runs ₹0.3–1/min but do not plan on a guess.

**Total current marginal cost ≈ ₹1.5–2.5/min + VoiceLink charges.**

Samvaad self-serve: **per-minute pricing is not public.** Verified facts only: usage-based pricing with free credits at signup ([Elets BFSI](https://bfsi.eletsonline.com/sarvam-ai-opens-voice-ai-platform-sarvam-samvaad-to-public-targets-wider-adoption/)); ₹100 free API credits for new users on the API side ([official pricing page](https://docs.sarvam.ai/api/pricing.md)); one aggregator claims "all plans include ₹1,000 free credits" (unofficial, **[VERIFY]**); the AWS enterprise listing bills per "60 Second Pulse" — i.e. per-minute metering — at a contract scale ($575K/yr) that tells us nothing about self-serve rates ([AWS listing](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio)). **Decision input: read the actual ₹/min (and number rental, if any) off the platform's billing page during the pilot, and compare against ~₹2–3/min all-in for the current stack.** A managed platform bundling telephony+STT+LLM+TTS will plausibly cost more per minute than raw APIs; whether that premium is worth deleting 3,000 lines of real-time code is the actual trade.

## 6. Recommendation

**Neither "migrate everything now" nor "stay put" — run a two-track week, then decide at a gate.**

### Track 1 — immediately, regardless of Samvaad (≈30 min)

1. **Re-export the prod store** (`/api/admin/export`) — the wedged Railway volume means the live agent config (`मराठी सहाय्यक`, prompt, greeting, DID mapping) is one redeploy away from vanishing. This is a prerequisite for §4 anyway.
2. **Set `CHAT_LLM_BASE_URL` / `CHAT_LLM_API_KEY`** in Railway (free Gemini key from aistudio.google.com/apikey). This activates the already-shipped bridge and collapses turn latency from ~6–10 s to ~1–1.5 s. It makes the fallback stack genuinely usable, which converts the Samvaad decision from an emergency into a choice.

### Track 2 — Samvaad pilot (this week)

3. Log into `platform.sarvam.ai/agents` with the existing dashboard account. If gated: product-page contact form / partnerships@sarvam.ai.
4. Build the pilot Marathi agent (§4 mapping), on free credits.
5. Resolve the four **decision gates**, in one session inside the platform:
   - **G1 Telephony:** does the platform provision a phone number (or Exotel connect, or SIP ingress)? Pick Option C, else B, per §2. If *no* phone path exists on self-serve → migration is dead for now; stay on custom+bridge and re-check quarterly.
   - **G2 Latency:** place real calls; measure caller-perceived response time across ≥10 Marathi turns. Pass: **≤1.5 s median** (i.e., meaningfully ≥ parity with custom+bridge, or better).
   - **G3 Cost:** read ₹/min + number charges off the billing page. Pass: total ≤ ~2× current all-in cost, given the operational savings.
   - **G4 Parity:** Marathi voice acceptably close to bulbul:v3/priya; human-transfer mechanism exists (we rely on `[[TRANSFER]]` today); call logs/transcripts visible.
6. **All four pass →** cut over: point/forward the number (B2 keeps the current DID during transition), run custom stack as fallback for ≥1 week of production traffic, then decommission Railway (which also buries the volume problem). **Any gate fails →** stay on custom+bridge (now fast, thanks to Track 1), file the specific gap with Sarvam, and revisit.

### Explicitly rejected

- **Hybrid A (WS-bridge VoiceLink audio into Samvaad):** no documented media-ingress API; it would preserve the worst part of our stack (custom media plumbing) to reach a platform whose whole point is deleting it.
- **Rebuilding on LiveKit/Pipecat with Sarvam plugins:** inherits the identical public-API reasoning delay (verified from the LiveKit plugin source); it's a rewrite that fixes nothing.

### Risks worth naming

- **Samvaad latency claim doesn't survive contact with Marathi reality** — the one independent datapoint (English 0.8 s vs Hindi 2.5–4 s in earlier-gen tests, 1.2–1.8 s unoptimized on current APIs, [GrowwStacks](https://growwstacks.com/blog/sarvam-ai-tts-stt-voice-agent-test)) says Indic latency can be multiples of English. Hence G2 as a hard gate.
- **Platform lock-in with in-platform-only docs and "all sales final" enterprise terms** — mitigated by keeping the export archive and the fallback stack.
- **Number continuity** — if G1 lands on Option C with a fresh number, the published number changes unless VoiceLink can forward (B2). Check whether the DID is printed anywhere immovable before cut-over.
- **Self-serve tier limits** (concurrency caps, channel restrictions) are unknown until login — the Inc42 reporting explicitly says free-tier usage limits exist ([Inc42](https://inc42.com/buzz/exclusive-sarvam-ai-to-open-voice-ai-agents-platform-for-public-use/)).

---

## Appendix: research notes & source index

- `sarvam.ai` and `platform.sarvam.ai` return 403 to automated fetching, so product-page claims above come via search snippets and secondary coverage; nothing behind the platform login has been seen. All **[VERIFY]** flags concentrate there — expect the first login session to retire most of them.
- Sources: [Samvaad product page](https://www.sarvam.ai/products/conversational-agents) · [AWS Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio) · [Sarvam docs pricing](https://docs.sarvam.ai/api/pricing.md) · [Sarvam docs index (llms.txt)](https://docs.sarvam.ai/llms.txt) · [Sarvam Samvaad launch post](https://x.com/SarvamAI/status/1932013070064193666) · [Sarvam WhatsApp voice post](https://x.com/SarvamAI/status/1963548479500030279) · [Elets BFSI on public opening](https://bfsi.eletsonline.com/sarvam-ai-opens-voice-ai-platform-sarvam-samvaad-to-public-targets-wider-adoption/) · [Inc42 exclusive](https://inc42.com/buzz/exclusive-sarvam-ai-to-open-voice-ai-agents-platform-for-public-use/) · [Let's Data Science](https://letsdatascience.com/news/sarvam-ai-opens-voice-agents-platform-to-public-a32ad441) · [Exotel on Sarvam partnership](https://exotel.com/blog/voice-ai-india-infrastructure-exotel/) · [VoiceLink](https://voicelink.co.in/) · [GrowwStacks latency test](https://growwstacks.com/blog/sarvam-ai-tts-stt-voice-agent-test) · [explainx.ai Sarvam guide](https://explainx.ai/blog/sarvam-ai-capabilities-api-models-guide-2026)
- Internal evidence: live API probes of 2026-07-09 / 2026-07-14 (reasoning not disableable; empty replies at low `max_tokens`), prod turn-latency logs (`sttMs/llmFirstMs/ttsFirstMs/firstAudioMs`), and the shipped fast-LLM bridge + streaming TTS (commit "Fast-LLM bridge + streaming TTS: sub-second replies with any OpenAI-compatible model").
