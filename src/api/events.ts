import { Router } from "express";
import { bus } from "../events";

export const eventsRouter = Router();

/** Server-Sent Events stream of live call/agent updates for the dashboard. */
eventsRouter.get("/", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: {}\n\n`);

  const unsub = bus.onEvent((e) => {
    res.write(`data: ${JSON.stringify(e)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsub();
  });
});
