import { Router } from "express";
import { z } from "zod";
import { config, panelUrls } from "../config";
import { chatProviderInfo } from "../llm/chat";
import { runDoctor } from "../sarvam/doctor";
import { db } from "../store/db";
import type { Settings } from "../store/types";
import { getVoicelinkLink } from "../voicelink/linkStatus";

export const settingsRouter = Router();

export const LANGUAGES = [
  { code: "auto", label: "Auto-detect (multilingual)" },
  { code: "en-IN", label: "English (India)" },
  { code: "hi-IN", label: "Hindi" },
  { code: "bn-IN", label: "Bengali" },
  { code: "gu-IN", label: "Gujarati" },
  { code: "kn-IN", label: "Kannada" },
  { code: "ml-IN", label: "Malayalam" },
  { code: "mr-IN", label: "Marathi" },
  { code: "od-IN", label: "Odia" },
  { code: "pa-IN", label: "Punjabi" },
  { code: "ta-IN", label: "Tamil" },
  { code: "te-IN", label: "Telugu" },
];

export const SPEAKERS = {
  "bulbul:v2": ["anushka", "manisha", "vidya", "arya", "abhilash", "karun", "hitesh"],
  "bulbul:v3": [
    "shubh", "aditya", "ritu", "priya", "neha", "rahul", "pooja", "rohan", "simran",
    "kavya", "amit", "dev", "ishita", "shreya", "varun", "manan", "sumit", "roopa",
    "kabir", "tanya", "tarun", "sunny", "vijay", "shruti", "suhani", "mohit", "soham",
  ],
};

settingsRouter.get("/", (_req, res) => {
  res.json({
    settings: db.getSettings(),
    panelUrls: panelUrls(),
    appBaseUrl: config.appBaseUrl,
    sarvam: {
      configured: config.sarvam.configured,
      baseUrl: config.sarvam.baseUrl,
      chatModel: config.sarvam.chatModel,
      sttModel: config.sarvam.sttModel,
      ttsModel: config.sarvam.ttsModel,
      ttsSpeaker: config.sarvam.ttsSpeaker,
    },
    outboundConfigured: config.voicelink.lead.configured,
    voicelinkLink: getVoicelinkLink(),
    chatProvider: chatProviderInfo(),
    ttsStreaming: config.ttsStreaming,
    defaultLanguage: config.defaultLanguage,
    options: {
      languages: LANGUAGES,
      speakers: SPEAKERS,
      ttsModels: Object.keys(SPEAKERS),
    },
  });
});

settingsRouter.put("/", (req, res) => {
  // defaultAgentId: null (or "") clears the fallback; a non-empty id must exist.
  const parsed = z
    .object({ defaultAgentId: z.string().nullable().optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const patch: Partial<Settings> = {};
  const { defaultAgentId } = parsed.data;
  if (defaultAgentId !== undefined) {
    if (defaultAgentId && !db.getAgent(defaultAgentId)) {
      return res.status(400).json({ error: "unknown defaultAgentId" });
    }
    patch.defaultAgentId = defaultAgentId || undefined;
  }
  res.json(db.updateSettings(patch));
});

settingsRouter.post("/doctor", async (_req, res) => {
  try {
    const report = await runDoctor();
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
