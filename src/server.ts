import { join } from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import { config, panelUrls } from "./config";
import { logger } from "./logger";
import { adminRouter } from "./api/admin";
import { agentsRouter } from "./api/agents";
import { callsRouter } from "./api/calls";
import { numbersRouter } from "./api/numbers";
import { settingsRouter } from "./api/settings";
import { eventsRouter } from "./api/events";
import { login, logout, me, requireAuth, safeEq } from "./api/auth";
import { handleVoicelinkWebhook } from "./voicelink/webhooks";
import { getVoicelinkLink } from "./voicelink/linkStatus";
import { chatProviderInfo } from "./llm/chat";

const log = logger.child({ mod: "server" });

export function buildApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });

  // /api/admin/import parses its own body with a much larger limit (see
  // api/admin.ts) — running the 1mb parser first would 413 big backups.
  const jsonBody = express.json({ limit: "1mb" });
  app.use((req, res, next) => {
    if (req.path.replace(/\/+$/, "") === "/api/admin/import") return next();
    jsonBody(req, res, next);
  });
  app.use(express.urlencoded({ extended: true }));

  // --- Health (unauthenticated) ---
  const startedAt = Date.now();
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      sarvamConfigured: config.sarvam.configured,
      outboundConfigured: config.voicelink.lead.configured,
      voicelink: getVoicelinkLink(),
      chat: chatProviderInfo(),
      ttsStreaming: config.ttsStreaming,
      time: new Date().toISOString(),
    });
  });

  // --- Auth ---
  app.post("/api/login", login);
  app.post("/api/logout", logout);

  // --- VoiceLink lifecycle webhook (token-guarded, not session) ---
  app.all("/webhooks/voicelink", (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!safeEq(token, config.webhookToken)) {
      return res.status(401).json({ error: "invalid token" });
    }
    try {
      const body = Object.keys(req.body || {}).length ? req.body : req.query;
      const result = handleVoicelinkWebhook(body);
      res.status(200).json(result);
    } catch (err) {
      log.error({ err }, "webhook error");
      res.status(200).json({ ok: false });
    }
  });

  // --- Protected API ---
  app.get("/api/me", requireAuth, me);
  app.use("/api", requireAuth);
  app.use("/api/admin", adminRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/calls", callsRouter);
  app.use("/api/numbers", numbersRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/events", eventsRouter);

  // --- Static dashboard ---
  const publicDir = join(process.cwd(), "public");
  app.use(express.static(publicDir));
  // SPA-ish fallback: serve the dashboard for any other GET.
  app.get("*", (req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/webhooks")) return next();
    res.sendFile(join(publicDir, "index.html"));
  });

  // JSON error responses — without this, body-parser errors (413 too large,
  // malformed JSON) fall through to Express's default HTML error page and the
  // dashboard's JSON.parse chokes on "<!DOCTYPE ...".
  const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const e = (err ?? {}) as { status?: number; statusCode?: number; type?: string; message?: string };
    const status =
      typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 500;
    if (status >= 500) log.error({ err }, "unhandled request error");
    const error =
      e.type === "entity.too.large"
        ? "payload too large"
        : e.type === "entity.parse.failed"
          ? "malformed JSON body"
          : status >= 500
            ? "internal error"
            : e.message || "bad request";
    res.status(status).json({ error });
  };
  app.use(errorHandler);

  log.info({ urls: panelUrls() }, "app built");
  return app;
}
