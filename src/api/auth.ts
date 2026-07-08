import { createHmac, timingSafeEqual } from "node:crypto";
import * as cookie from "cookie";
import type { RequestHandler } from "express";
import { config } from "../config";

const COOKIE = "ca_session";

export function sessionToken(): string {
  return createHmac("sha256", config.sessionSecret).update("v1:admin").digest("hex");
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isAuthed(req: Parameters<RequestHandler>[0]): boolean {
  const hdr = req.headers.authorization || "";
  if (hdr.startsWith("Bearer ")) {
    const tok = hdr.slice(7);
    if (safeEq(tok, config.dashboardPassword) || safeEq(tok, sessionToken())) return true;
  }
  const cookies = cookie.parse(req.headers.cookie || "");
  const c = cookies[COOKIE];
  if (c && safeEq(c, sessionToken())) return true;
  return false;
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "unauthorized" });
};

export const login: RequestHandler = (req, res) => {
  const password = (req.body && req.body.password) as unknown;
  if (typeof password === "string" && safeEq(password, config.dashboardPassword)) {
    res.cookie(COOKIE, sessionToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProd,
      maxAge: 30 * 24 * 3600 * 1000,
      path: "/",
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "invalid password" });
};

export const logout: RequestHandler = (_req, res) => {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
};

export const me: RequestHandler = (_req, res) => {
  res.json({ authenticated: true });
};
