import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as cookie from "cookie";
import type { Request, RequestHandler } from "express";
import { config } from "../config";

const COOKIE = "ca_session";

export function sessionToken(): string {
  // Derived from BOTH secrets so rotating either SESSION_SECRET or
  // DASHBOARD_PASSWORD invalidates every previously issued session.
  return createHmac("sha256", config.sessionSecret)
    .update(`v1:admin:${config.dashboardPassword}`)
    .digest("hex");
}

/** Constant-time string comparison that does not leak credential length. */
export function safeEq(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

/**
 * Brute-force guard: after MAX_AUTH_FAILURES bad passwords / Bearer tokens
 * from one IP within the window, password login and Bearer auth from that IP
 * are refused until the window expires. Session cookies keep working — they
 * are unguessable 256-bit HMACs, so counting them would only let an attacker
 * lock out an already signed-in operator.
 */
const MAX_AUTH_FAILURES = 10;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const authFailures = new Map<string, { count: number; resetAt: number }>();

function ipKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function authLimited(key: string): boolean {
  const entry = authFailures.get(key);
  if (!entry) return false;
  if (Date.now() >= entry.resetAt) {
    authFailures.delete(key);
    return false;
  }
  return entry.count >= MAX_AUTH_FAILURES;
}

function recordAuthFailure(key: string): void {
  const now = Date.now();
  if (authFailures.size >= 10_000) {
    for (const [k, v] of authFailures) if (now >= v.resetAt) authFailures.delete(k);
  }
  const entry = authFailures.get(key);
  if (!entry || now >= entry.resetAt) {
    authFailures.set(key, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function isAuthed(req: Request): boolean {
  const cookies = cookie.parse(req.headers.cookie || "");
  const c = cookies[COOKIE];
  if (c && safeEq(c, sessionToken())) return true;

  const hdr = req.headers.authorization || "";
  if (hdr.startsWith("Bearer ")) {
    const key = ipKey(req);
    if (!authLimited(key)) {
      const tok = hdr.slice(7);
      if (safeEq(tok, config.dashboardPassword) || safeEq(tok, sessionToken())) return true;
      recordAuthFailure(key);
    }
  }
  return false;
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "unauthorized" });
};

export const login: RequestHandler = (req, res) => {
  const key = ipKey(req);
  if (authLimited(key)) {
    return res.status(429).json({ ok: false, error: "too many failed attempts, try again later" });
  }
  const password = (req.body && req.body.password) as unknown;
  if (typeof password === "string" && safeEq(password, config.dashboardPassword)) {
    authFailures.delete(key);
    res.cookie(COOKIE, sessionToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProd,
      maxAge: 30 * 24 * 3600 * 1000,
      path: "/",
    });
    return res.json({ ok: true });
  }
  recordAuthFailure(key);
  res.status(401).json({ ok: false, error: "invalid password" });
};

export const logout: RequestHandler = (_req, res) => {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
};

export const me: RequestHandler = (_req, res) => {
  res.json({ authenticated: true });
};
