import { config } from "../src/config";
import { runDoctor } from "../src/sarvam/doctor";

/** CLI: `npm run doctor` — probes the Sarvam integration end-to-end. */
async function main() {
  console.log(`Sarvam base URL : ${config.sarvam.baseUrl}`);
  console.log(`API key set     : ${config.sarvam.configured ? "yes" : "NO"}`);
  console.log("Running probes (TTS → STT round-trip, chat model resolution)…\n");

  const r = await runDoctor();
  console.log(JSON.stringify(r, null, 2));

  console.log("");
  console.log(`TTS  : ${r.tts.ok ? "OK (" + r.tts.bytes + " bytes A-law)" : "FAIL — " + r.tts.detail}`);
  console.log(`STT  : ${r.stt.ok ? 'OK — "' + r.stt.transcript + '"' : "FAIL — " + r.stt.detail}`);
  console.log(`Chat : ${r.chat.ok ? "OK — model " + r.chat.workingModel : "FAIL — no model responded"}`);

  if (r.chat.workingModel && r.chat.workingModel !== config.sarvam.chatModel) {
    console.log(`\n👉 Update your env: SARVAM_CHAT_MODEL=${r.chat.workingModel}`);
  }
  process.exit(r.tts.ok && r.chat.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
