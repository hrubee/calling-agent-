# Real-time Marathi voice agents: the 2026 landscape

**Status:** research survey · researched 2026-07-15 · task `marathi-voice-research`

**Question:** beyond the two options already on the table (custom VoiceLink+Sarvam stack with the fast-LLM bridge, and Sarvam Samvaad — see [samvaad-migration-plan.md](./samvaad-migration-plan.md)), what does the wider market offer for a **real-time, telephone-grade Marathi voice agent**, and does anything change our decision?

**TL;DR:** Marathi went from a niche capability to table stakes in the last ~18 months. Every major layer now has credible Marathi support: native speech-to-speech models (OpenAI gpt-realtime family, Gemini Live), managed agent platforms (ElevenLabs Agents, Bolna, Gnani, Smallest.ai — plus Samvaad), and best-in-class components for DIY (Sarvam saaras/bulbul now with **streaming WebSockets**, Soniox, Google Chirp 3 HD, Azure mr-IN voices, Cartesia). Three findings matter for us:

1. **Sarvam shipped streaming STT (WebSocket, `saaras:v3`, <150 ms claimed TTFT) and a new flagship LLM (`sarvam-105b`)** since our stack was built. Streaming STT is a drop-in upgrade for the custom stack; sarvam-105b is still a reasoning model (~2 s TTFT measured by Artificial Analysis) so it does **not** replace the fast-LLM bridge.
2. **ElevenLabs Agents is the strongest non-Sarvam managed alternative** — 11 Indian languages incl. Marathi, SIP-trunk ingress (which Samvaad may not have), $0.08/min platform fee + LLM + telephony (≈ ₹7+/min all-in, i.e. ~3× our current marginal cost).
3. Nothing found here overturns the existing two-track plan (bridge key now, Samvaad pilot this week). The additions: adopt Sarvam streaming STT in the custom stack regardless of the migration outcome, and treat **ElevenLabs Agents** (managed) and **Gemini Live via Pipecat/LiveKit** (DIY speech-to-speech, ≈ ₹1.5–2.5/min) as the ranked fallbacks if Samvaad fails its gates.

House rules as in the migration plan: every claim carries a source; anything we could not verify is flagged **[VERIFY]**. Marketing latency numbers are labeled as claims, not measurements.

---

## 1. Three architectures for a Marathi voice agent

| Architecture | What it is | Marathi-capable examples (2026) | Trade-off |
|---|---|---|---|
| **A. Managed full-stack platform** | Vendor runs STT→LLM→TTS (or S2S), interruption handling, telephony, analytics; you configure an agent | Sarvam Samvaad, ElevenLabs Agents, Bolna, Gnani.ai, Smallest.ai Atoms, Ozonetel, OpenMic | Least code, fastest to ship, per-minute premium, lock-in |
| **B. DIY cascaded pipeline** | You own the loop: streaming STT → fast LLM → streaming TTS, over a media stream from a telephony provider | Our current stack; Pipecat/LiveKit with Sarvam / Soniox / Google / ElevenLabs plugins | Full control and lowest marginal cost; you maintain VAD, barge-in, codecs (we know exactly what that costs us) |
| **C. Native speech-to-speech (S2S) model** | One model consumes and produces audio directly — no separate STT/TTS, sub-second by construction | OpenAI gpt-realtime-2 (and mini), Gemini Live native audio | Simplest latency story; Marathi voice quality/register unproven vs Indic-specialist TTS; still needs a telephony bridge |

Our current stack is (B). Samvaad is (A). The genuinely new option since the original build is (C) — in 2024–25 the S2S models had no meaningful Marathi; now both major ones list it.

## 2. Managed platforms with Marathi (Architecture A)

### 2.1 Sarvam Samvaad
Covered exhaustively in [samvaad-migration-plan.md](./samvaad-migration-plan.md); summary for comparison: 11 languages incl. Marathi, phone + WhatsApp + web channels, "sub-second" claimed, self-serve since ~June 2026, per-minute price unpublished ([product page](https://www.sarvam.ai/products/conversational-agents), [AWS listing](https://aws.amazon.com/marketplace/pp/prodview-x5iks3edtmaio)). Four decision gates (telephony path, measured latency, ₹/min, voice/handoff parity) remain open until the pilot.

### 2.2 ElevenLabs Agents — the strongest non-Sarvam managed option
- **Marathi:** supported as one of **11 Indian languages** (Hindi, Bengali, Marathi, Telugu, Tamil, Kannada, Gujarati, Malayalam, Punjabi, Urdu, Assamese), with an explicit India push — "voices that sound native, not translated" ([India infrastructure blog](https://elevenlabs.io/blog/powering-indian-voice-agent-infrastructure), [Marathi TTS page](https://elevenlabs.io/text-to-speech/marathi)). STT (Scribe) covers Marathi among 99 languages ([Marathi STT page](https://elevenlabs.io/speech-to-text/marathi)).
- **Telephony:** native Twilio integration **and self-serve SIP trunking** — you connect your own trunk ([SIP trunking docs](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking)). This is a concrete advantage over Samvaad, whose ingress story is still unknown: VoiceLink advertises SIP connectivity, so a **VoiceLink DID → SIP trunk → ElevenLabs** path exists on paper (both halves **[VERIFY]** — same caveat as Option B1 in the migration plan).
- **Price:** $0.08/min platform fee ($0.16 burst above concurrency cap), **LLM and telephony billed separately** ([pricing help article](https://help.elevenlabs.io/hc/en-us/articles/29298065878929-How-much-does-ElevenAgents-cost), [agents pricing page](https://elevenlabs.io/pricing/agents)). At ₹85–90/$ that's **≈ ₹7/min before LLM and telco** — roughly 3× the current stack's ~₹2–3/min all-in. Plan tiers bundle some minutes (Free 15 → Business ~12,375/mo).
- **Latency:** ElevenLabs claims sub-100 ms for its TTS leg ([India blog](https://elevenlabs.io/blog/powering-indian-voice-agent-infrastructure)); end-to-end turn latency on Marathi over Indian telephony is unpublished — **[VERIFY with a pilot agent]**.
- **Credibility in India:** Cars24, Razorpay, Unacademy, Meesho, Apna, Skit AI listed as customers ([India blog](https://elevenlabs.io/blog/powering-indian-voice-agent-infrastructure)); ran its first India out-of-home campaign in 2026 ([Business News This Week](https://businessnewsthisweek.com/technology/elevenlabs-launches-first-ooh-campaign-in-india-to-spotlight-ai-voice-agents-for-customer-support/)).
- **Fit:** best fallback if Samvaad fails G1 (no telephony path) or G4 (voice parity), because SIP ingress + bring-your-own-LLM removes the two most likely Samvaad failure modes. The cost premium is the price of that flexibility.

### 2.3 Bolna — India-first, YC-backed
- Marathi explicitly supported; "50+ languages … with real-time language-switching"; claims **<300 ms** interruption-aware replies (marketing) ([bolna.ai](https://www.bolna.ai/), [YC profile](https://www.ycombinator.com/companies/bolna-ai)).
- Pricing is public and simple: **~$0.06–0.10/min** depending on tier (Starter $100/1,000 min; Growth $250/4,000 min; pay-as-you-go ≈ 6¢/min) ([Bolna pricing breakdown](https://blog.dograh.com/bolna-ai-pricing-breakdown-and-how-open-source-saves-70/), [ToolJunction review](https://www.tooljunction.io/ai-tools/bolna-ai)) → ≈ ₹5–9/min.
- Uses Sarvam as one of its pluggable transcribers ([Bolna docs: Sarvam transcriber](https://www.bolna.ai/docs/providers/transcriber/sarvam)) — i.e. partially the same underlying Indic models we already use, with a platform margin on top. Indian telephony integrations (Exotel/Plivo) are native.
- **Fit:** credible, but hard to justify paying platform margin for the same Sarvam components we call directly — unless we simply want the orchestration/ops off our hands and Samvaad is unavailable.

### 2.4 Gnani.ai — enterprise Indic specialist
- Largest India-headquartered voice-AI vendor by ARR; 30M+ daily conversations; HDFC Bank, Bank of Baroda, Tata Motors, Airtel as customers; deep Marathi coverage in production BFSI collections ([gnani.ai](https://www.gnani.ai/), [Caller Digital comparison](https://caller.digital/blog/top-10-ai-voice-calling-platforms-india-2026)).
- Full proprietary stack (Prisma STT, Timbre TTS, **Warp speech-to-speech**, Aion/Evon LLMs); native integrations with Exotel, Ozonetel, Plivo, Knowlarity, Tata Tele, Twilio.
- Sales-led, enterprise contracts; no self-serve public pricing found — **[VERIFY via sales if ever relevant]**. **Fit:** wrong scale for us (single agent, one DID); listed for completeness.

### 2.5 Smallest.ai — component vendor with an agent platform
- Indian company; **Lightning TTS claims sub-100 ms first audio** with strong Indic coverage incl. Marathi; Pulse STT (38 languages); Atoms agent platform on top ([smallest.ai](https://smallest.ai/), [TTS page](https://smallest.ai/text-to-speech)).
- Atoms per-minute pricing not confirmed in this pass — **[VERIFY]**. **Fit:** the TTS is the interesting piece (see §4.2); the platform is younger than the alternatives above.

### 2.6 Vapi / Retell — not for this use-case
Both are strong US-centric orchestrators, but multiple independent India-focused comparisons agree they lack Indic depth: Hindi plus generic multilingual, no Marathi-optimized pipeline, US telephony pricing stacked on top ([Vomyra comparison](https://vomyra.com/blogs/vapi-vs-bland-vs-retell-for-india-us-platforms-cant-do-this), [Tough Tongue comparison](https://www.toughtongueai.com/blog/best-voice-ai-platform-india-2026)). **Rejected.**

### 2.7 Others seen but not shortlisted
Ozonetel (telephony-native voicebots, session-based rather than streaming ([Caller Digital telephony guide](https://www.caller.digital/blog/telephony-partner-voice-ai-india-plivo-exotel-ozonetel-knowlarity-twilio-2026))), OpenMic.ai (Marathi landing page, thin public evidence ([openmic.ai](https://www.openmic.ai/language/marathi))), Soniox's own agent platform (compelling STT, see §4.1, but the platform is new ([soniox.com/platform/marathi](https://soniox.com/platform/marathi))), Ringg.ai, Vodex, Awaaz.ai, CallerDigital — a crowded tier of India-first startups; none showed a decisive advantage over Bolna/Gnani in public materials.

## 3. Native speech-to-speech models (Architecture C)

The structurally new option: one model, audio-in/audio-out, no cascade to tune. Neither vendor sells telephony — both need a bridge (Pipecat/LiveKit/Twilio-style media stream server, i.e. a slimmer version of the plumbing we already own in `src/ws/mediaStream.ts`).

### 3.1 OpenAI gpt-realtime family
- May 2026 refresh split the offering: **gpt-realtime-2** (general voice agent), gpt-realtime-translate, gpt-realtime-whisper ([OpenAI announcement](https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/), [realtime guide](https://developers.openai.com/api/docs/guides/realtime)). Marathi appears in the 70+ supported input languages ([aitechconnect coverage](https://aitechconnect.in/news/openai-voice-intelligence-api-realtime-2026)); **spoken Marathi output quality/register is unbenchmarked — [VERIFY by demo]**.
- Pricing (audio tokens): gpt-realtime-2 $32/M in, $64/M out; **mini at $10/$20** ([OpenAI pricing](https://developers.openai.com/api/docs/pricing)). Real-world: **$0.18–0.46/min uncached, $0.04–0.10/min with caching + VAD trimming** ([HackerNoon measured sessions](https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions), [Callsphere math](https://callsphere.ai/blog/vw2c-openai-realtime-cost-per-minute-math-2026)) → **≈ ₹3.5–9/min optimized on the flagship; mini ≈ ₹1.5–3/min**. Cost grows with conversation length (context re-billing) — a known trap on long calls.
- Latency: sub-second first audio is the product's design point (claims; no Marathi-specific measurement found).

### 3.2 Gemini Live API — the sleeper option
- Native-audio S2S (not a cascade), barge-in, tool calling, affective dialog; **Marathi is one of the ~10 supported Indian languages** ([Live API docs](https://ai.google.dev/gemini-api/docs/live-api), [language/voice config](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api/configure-language-voice)).
- Pricing is the standout: $3/M audio-in, $12/M audio-out tokens; at 32 tok/s in and 25 tok/s out that is **≈ $0.006/min listening + ≈ $0.018/min while speaking** ([Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [rywalker breakdown](https://rywalker.com/research/gemini-live-api)). A typical call (agent speaks ~40–50% of the time) pencils out to **≈ $0.015–0.025/min ≈ ₹1.3–2.2/min — comparable to our raw-API cost today**, for a sub-second S2S loop. Free tier exists for prototyping.
- Marathi *voice* quality vs bulbul (a Marathi-tuned TTS) is the open question — Google's HD voices are multilingual generalists. **[VERIFY by A/B against bulbul:v3/priya]**.
- Integration: first-class Pipecat and LiveKit support; our existing VoiceLink WS media endpoint could feed it, or we adopt Pipecat and delete our hand-rolled VAD/barge-in (Gemini Live handles interruptions natively).
- **Fit:** if we ever rebuild the custom stack, this is the architecture to rebuild on — it deletes STT, TTS, VAD, and barge-in code in one move at roughly today's marginal cost. It is *not* this week's move (Samvaad pilot first), but it beats "custom cascade v2" as the long-term DIY end-state. Worth a half-day spike.

## 4. Best-in-class Marathi components (Architecture B upgrades)

Even if we stay on the custom stack, three component upgrades surfaced.

### 4.1 STT
| Engine | Marathi | Streaming | Latency claim | Notes |
|---|---|---|---|---|
| **Sarvam saaras:v3 (WS)** | ✅ core | **✅ WebSocket, new** | **<150 ms TTFT "fast mode"** | The headline change since our build: [streaming STT API](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api), [WS endpoint](https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe/ws). PCM/WAV input only. `saarika:v2.5` now "legacy". Modes: transcribe/translate/verbatim/translit/codemix. |
| Soniox | ✅ | ✅ | <200 ms, early tokens + endpoint detection | ~$0.12/hr live (≈ ₹0.18/min) — cheap; 60+ languages, code-switching ([soniox.com](https://soniox.com/speech-to-text/marathi), [pricing](https://soniox.com/pricing)) |
| Google Chirp 3 | ✅ mr-IN | ✅ | — | Solid, GCP dependency ([Chirp 3 docs](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3)) |
| Azure Speech | ✅ mr-IN | ✅ | — | Mature SDK ([language support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)) |
| ElevenLabs Scribe | ✅ | ✅ | — | ([Marathi STT](https://elevenlabs.io/speech-to-text/marathi)) |
| AI4Bharat IndicConformer | ✅ (22 langs) | partial | — | Open source, self-host ([GitHub](https://github.com/AI4Bharat/IndicConformerASR)) |
| Deepgram | ❌ | — | — | No Marathi ([Cartesia comparison](https://www.cartesia.ai/vs/cartesia-vs-deepgram)) |

On accuracy: the *Voice of India* benchmark (2026) found **Sarvam's audio models lowest-WER in 13 of 15 Indian languages, with Saarika 2.5 next** ([arXiv](https://arxiv.org/html/2604.19151v2)) — i.e. we are already on the accuracy leader for Marathi; the upgrade available to us is *streaming*, not accuracy.

**Actionable:** replace the batch call in `src/sarvam/stt.ts` with the saaras:v3 WebSocket. Cuts STT wait (~whole-utterance upload + inference) to streaming partials, enables server-side endpointing, and would let us shrink or delete our own VAD endpointing logic. This pays off in **both** the stay-custom and the pilot-fallback worlds. **[VERIFY the <150 ms claim and Marathi partial-transcript quality with a probe, as we did for chat latency.]**

### 4.2 TTS
| Engine | Marathi | Streaming | Latency claim | Cost signal |
|---|---|---|---|---|
| **Sarvam bulbul:v3** (current) | ✅ tuned, 30+ voices | ✅ WS (we shipped this 07-14) | ~0.47 s measured by us | ₹30/10K chars ([pricing](https://docs.sarvam.ai/api/pricing.md)) |
| Smallest.ai Lightning | ✅ | ✅ | **sub-100 ms** (claim) | — ([smallest.ai](https://smallest.ai/text-to-speech)) |
| ElevenLabs (v3 / Flash) | ✅ | ✅ | sub-100 ms on Flash (claim) | premium per-char pricing |
| Cartesia Sonic-3 | ✅ (42 langs) | ✅ | low; Indic quality updates still pending ([changelog](https://docs.cartesia.ai/changelog/2026)) | — |
| Google Chirp 3 HD | ✅ mr-IN (new locale) | ✅ `streaming_synthesize` | — | ([Chirp 3 HD docs](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd)) |
| Azure Aarohi/Manohar | ✅ mr-IN | ✅ | — | ([voice list](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)) |
| AI4Bharat IndicF5 / Indic Parler-TTS | ✅ | self-host | GPU-dependent | Open source ([IndicF5](https://huggingface.co/ai4bharat/IndicF5), [Indic Parler-TTS](https://huggingface.co/ai4bharat/indic-parler-tts)) |

Our measured bulbul streaming leg (~0.47 s to first audio) is already good; sub-100 ms vendors would shave ~0.3–0.4 s at the cost of a second vendor relationship and an unproven Marathi voice. **Not worth switching now**; revisit only if a latency audit shows TTS as the binding constraint (today the LLM is).

### 4.3 LLM
- **sarvam-105b** (new, open-sourced alongside 30b, [Sarvam blog](https://www.sarvam.ai/blogs/sarvam-30b-105b)): still a reasoning model — Artificial Analysis measures **~2.1 s TTFT at high reasoning effort** on Sarvam's own serving, with reasoning tokens billed as completion tokens ([Artificial Analysis](https://artificialanalysis.ai/models/sarvam-105b/providers)). 2.1 s is far better than the 5–10 s we measured on sarvam-30b, and third-party docs imply `reasoning_effort` is a real dial on 105b — **[VERIFY with the same live probe we used on 30b; if low-effort TTFT lands under ~1 s, the bridge could point at sarvam-105b and keep everything in one vendor]**. Until probed, assume it does not beat a Flash-class model.
- The fast-LLM bridge conclusion from the migration plan stands: any OpenAI-compatible fast model (Gemini Flash, gpt-4o-mini class) at sub-second TTFT remains the custom stack's latency fix, and Marathi text competence in frontier fast models is adequate for phone-call register.

## 5. Telephony reality check (applies to every non-Samvaad option)

From the India telephony comparison for voice AI ([Caller Digital, 2026](https://www.caller.digital/blog/telephony-partner-voice-ai-india-plivo-exotel-ozonetel-knowlarity-twilio-2026)):

- **Media streaming maturity:** Plivo, Twilio, Exotel have mature media-stream APIs; Ozonetel/Knowlarity historically session-based. (VoiceLink, our incumbent, speaks a Twilio-media-streams-style WS — already the right shape.)
- **Latency budget:** bad SIP routing adds 150–400 ms; a good carrier→AI round trip should add <80 ms. Any platform pilot (Samvaad, ElevenLabs) must be measured over the *real* phone path, not the web demo — this is exactly gate G2.
- **Costs (INR/min):** inbound DID ₹0.40–0.90; outbound mobile ₹0.60–1.80; Twilio ≈ 2–3× Plivo/Exotel in India. So telco adds roughly ₹0.5–1.5/min to any BYO-telephony option.
- **Compliance:** DLT registration under TRAI rules is mandatory for outbound; Exotel/Knowlarity/Ozonetel have the strongest DLT operations, Twilio the thinnest. If outbound campaigns ever become real (the never-activated `src/voicelink/outbound.ts` path), DLT is a week-one item, not an afterthought.

## 6. Consolidated comparison

Costs assume ₹85–90/$; "all-in" includes telephony where the platform bundles it, else noted. Latency: **(m)** = our measurement, **(c)** = vendor claim, **(i)** = independent third-party test.

| Option | Arch | Marathi depth | First-audio latency | Est. all-in ₹/min | Telephony | Verdict |
|---|---|---|---|---|---|---|
| Custom stack today (sarvam-30b) | B | ✅✅ (Saarika/bulbul are Marathi SOTA) | 6–10 s **(m)** | ~₹2–3 + VoiceLink | VoiceLink DID (works) | Unacceptable latency; being fixed by ↓ |
| Custom + fast-LLM bridge | B | ✅✅ | ~1–1.5 s (est.) | ~₹2–3 + VoiceLink | VoiceLink DID | **Baseline. Turn on the key.** |
| + saaras:v3 streaming STT | B | ✅✅ | est. −0.2–0.5 s vs above **[VERIFY]** | unchanged | VoiceLink DID | **Do regardless of migration outcome** |
| Sarvam Samvaad | A | ✅✅ | <1 s **(c)** / 0.8–1.8 s **(i, proxy)** | unpublished **[VERIFY]** | in-platform **[VERIFY]** | **Pilot this week per existing plan** |
| ElevenLabs Agents | A | ✅ (11 Indic langs) | sub-100 ms TTS leg **(c)**; e2e **[VERIFY]** | ≈ ₹7 + LLM + telco | **SIP trunk (documented)** | **Fallback #1 if Samvaad fails G1/G4** |
| Gemini Live (via Pipecat) | C | ✅ (listed; voice quality **[VERIFY]**) | sub-second by design **(c)** | ≈ ₹1.3–2.2 + telco | BYO (our WS or Pipecat) | **Fallback #2 / long-term DIY end-state; spike-worthy** |
| gpt-realtime-2 / mini | C | ✅ input; output register **[VERIFY]** | sub-second **(c)** | ₹3.5–9 (flagship, optimized) / ₹1.5–3 (mini) | BYO | Viable; costlier than Gemini Live, weaker Indic story |
| Bolna | A | ✅ (uses Sarvam parts) | <300 ms **(c)** | ≈ ₹5–9 incl. telco | Exotel/Plivo native | Paying margin on components we already call directly |
| Gnani.ai | A | ✅✅ (BFSI-proven) | — | enterprise, unpublished | native Indian telco | Wrong scale for one agent/one DID |
| Vapi / Retell | A | ⚠️ thin | — | $ + US telco stacking | Twilio-centric | Rejected for India/Marathi |

## 7. What changes for us

1. **Nothing dethrones the two-track plan.** Track 1 (set `CHAT_LLM_API_KEY`) and Track 2 (Samvaad pilot against gates G1–G4) proceed exactly as written in the migration plan.
2. **New Track 1.5 — adopt Sarvam streaming STT.** The saaras:v3 WebSocket didn't exist when `src/sarvam/stt.ts` was written. It's the same vendor, same billing, strictly better shape (partials + endpointing), and benefits every future in which the custom stack is alive (including the "Samvaad failed, stay custom" branch). Small, contained change; probe latency first.
3. **The Samvaad gate outcomes now have named fallbacks.** If G1 (telephony) or G4 (parity) fails → **ElevenLabs Agents** pilot over a VoiceLink SIP trunk (verify VoiceLink SIP-forward self-serve first). If cost (G3) is the failure or we simply stay DIY long-term → **spike Gemini Live + Pipecat**: comparable per-minute cost to raw Sarvam APIs, deletes our VAD/barge-in/STT/TTS code, keeps VoiceLink. Probe its Marathi voice against bulbul:v3/priya before committing — Indic-tuned TTS is the one thing the generalists may still lose on.
4. **Probe sarvam-105b once, cheaply.** Same probe harness as the 30b tests; if low-reasoning TTFT is sub-second, the bridge target can stay in-family. Expectation set accordingly: Artificial Analysis' 2.1 s says probably not, but the probe is 10 minutes.
5. **If outbound ever activates, DLT registration is a blocker** on every BYO-telephony path — schedule it before the first campaign, not after the first TRAI notice.

---

## Appendix: source index

Platforms: [Sarvam Samvaad product page](https://www.sarvam.ai/products/conversational-agents) · [ElevenLabs India infrastructure blog](https://elevenlabs.io/blog/powering-indian-voice-agent-infrastructure) · [ElevenLabs Agents pricing](https://elevenlabs.io/pricing/agents) · [ElevenLabs Agents cost help article](https://help.elevenlabs.io/hc/en-us/articles/29298065878929-How-much-does-ElevenAgents-cost) · [ElevenLabs SIP trunking docs](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking) · [ElevenLabs Marathi TTS](https://elevenlabs.io/text-to-speech/marathi) / [Marathi STT](https://elevenlabs.io/speech-to-text/marathi) · [Bolna](https://www.bolna.ai/) · [Bolna pricing breakdown (Dograh)](https://blog.dograh.com/bolna-ai-pricing-breakdown-and-how-open-source-saves-70/) · [Bolna Sarvam transcriber docs](https://www.bolna.ai/docs/providers/transcriber/sarvam) · [Gnani.ai](https://www.gnani.ai/) · [Smallest.ai](https://smallest.ai/) · [OpenMic Marathi](https://www.openmic.ai/language/marathi) · [Soniox Marathi platform](https://soniox.com/platform/marathi) · [Vomyra on Vapi/Bland/Retell in India](https://vomyra.com/blogs/vapi-vs-bland-vs-retell-for-india-us-platforms-cant-do-this) · [Tough Tongue India platform comparison](https://www.toughtongueai.com/blog/best-voice-ai-platform-india-2026)

S2S models: [OpenAI voice intelligence announcement](https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/) · [OpenAI realtime guide](https://developers.openai.com/api/docs/guides/realtime) · [OpenAI pricing](https://developers.openai.com/api/docs/pricing) · [HackerNoon realtime pricing field data](https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions) · [Callsphere per-minute math](https://callsphere.ai/blog/vw2c-openai-realtime-cost-per-minute-math-2026) · [Gemini Live API docs](https://ai.google.dev/gemini-api/docs/live-api) · [Gemini Live language/voice config (Vertex)](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api/configure-language-voice) · [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) · [rywalker Gemini Live research](https://rywalker.com/research/gemini-live-api)

Components: [Sarvam streaming STT guide](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api) · [Sarvam STT WebSocket endpoint](https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe/ws) · [Sarvam TTS streaming WS](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/streaming-api/web-socket) · [Sarvam 30B/105B open-source blog](https://www.sarvam.ai/blogs/sarvam-30b-105b) · [Artificial Analysis: sarvam-105b](https://artificialanalysis.ai/models/sarvam-105b/providers) · [Sarvam API pricing](https://docs.sarvam.ai/api/pricing.md) · [Soniox pricing](https://soniox.com/pricing) · [Google Chirp 3 HD TTS](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd) · [Google Chirp 3 STT](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3) · [Azure Speech language support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support) · [Cartesia 2026 changelog](https://docs.cartesia.ai/changelog/2026) · [Cartesia vs Deepgram](https://www.cartesia.ai/vs/cartesia-vs-deepgram) · [AI4Bharat IndicF5](https://huggingface.co/ai4bharat/IndicF5) · [Indic Parler-TTS](https://huggingface.co/ai4bharat/indic-parler-tts) · [IndicConformer](https://github.com/AI4Bharat/IndicConformerASR) · [Voice of India ASR benchmark (arXiv)](https://arxiv.org/html/2604.19151v2)

Telephony/India: [Caller Digital telephony comparison 2026](https://www.caller.digital/blog/telephony-partner-voice-ai-india-plivo-exotel-ozonetel-knowlarity-twilio-2026) · [Exotel on Sarvam partnership](https://exotel.com/blog/voice-ai-india-infrastructure-exotel/) · [VoiceLink](https://voicelink.co.in/)

Prior internal work: [samvaad-migration-plan.md](./samvaad-migration-plan.md) (2026-07-14) — telephony options A–D, Samvaad gates G1–G4, cost baseline, live-probe evidence on sarvam-30b reasoning latency.
