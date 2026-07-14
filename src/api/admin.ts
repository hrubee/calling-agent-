import { json, Router } from "express";
import { db } from "../store/db";

/**
 * Admin backup/restore: full JSON-store export and import. Used for volume
 * migrations and off-site backups. Auth is enforced by the /api middleware.
 */
export const adminRouter = Router();

adminRouter.get("/export", (_req, res) => {
  res.setHeader("Content-Disposition", "attachment; filename=db-export.json");
  res.json(db.exportAll());
});

adminRouter.post("/import", json({ limit: "50mb" }), (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || !Array.isArray(body.agents)) {
    return res.status(400).json({ error: "expected a full DB export (agents/calls/numbers/settings)" });
  }
  db.importAll(body);
  res.json({
    ok: true,
    agents: body.agents.length,
    calls: Array.isArray(body.calls) ? body.calls.length : 0,
    numbers: Array.isArray(body.numbers) ? body.numbers.length : 0,
  });
});
