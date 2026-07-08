import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { config, generatedSecrets, panelUrls } from "./config";
import { logger } from "./logger";
import { buildApp } from "./server";
import { attachMediaStream } from "./ws/mediaStream";
import { db } from "./store/db";
import { warmAllGreetings } from "./agent/greeting";

const log = logger.child({ mod: "main" });

const app = buildApp();
const server = createServer(app);

// --- VoiceLink media-stream WebSocket bot ---
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  let token = "";
  try {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    pathname = url.pathname;
    token = url.searchParams.get("token") || "";
  } catch {
    socket.destroy();
    return;
  }

  if (pathname !== "/media-stream") {
    socket.destroy();
    return;
  }
  if (token !== config.wssToken) {
    log.warn("rejected media-stream upgrade: bad token");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    log.info("media-stream connected");
    attachMediaStream(ws);
  });
});

server.listen(config.port, () => {
  const urls = panelUrls();
  log.info(`🚀 Calling Agent listening on :${config.port} (${config.env})`);
  log.info(`   Dashboard:      ${config.appBaseUrl || `http://localhost:${config.port}`}`);
  log.info(`   VoiceLink WSS:  ${urls.wssUrl}`);
  log.info(`   VoiceLink hook: ${urls.webhookUrl}`);
  if (!config.sarvam.configured) {
    log.warn("SARVAM_API_KEY is not set — STT/LLM/TTS are disabled until you configure it.");
  } else {
    warmAllGreetings().catch((err) => log.warn({ err }, "greeting warm-up failed"));
  }
  if (generatedSecrets.length) {
    log.warn(
      { generated: generatedSecrets },
      "Some secrets were auto-generated for this run. Set them explicitly in production so they persist across restarts.",
    );
    if (generatedSecrets.includes("DASHBOARD_PASSWORD")) {
      log.warn(`   Dashboard password (generated): ${config.dashboardPassword}`);
    }
  }
});

// --- Graceful shutdown ---
function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  db.flushSync();
  wss.clients.forEach((c) => c.close());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => log.error({ err }, "uncaughtException"));
process.on("unhandledRejection", (err) => log.error({ err }, "unhandledRejection"));
