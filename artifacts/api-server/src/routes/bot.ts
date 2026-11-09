import { Router, type IRouter } from "express";
import { getBotStatus } from "../bot/whatsapp";
import { getAllSettings, setSetting } from "../bot/settings";

const router: IRouter = Router();

// GET /api/bot/status
router.get("/bot/status", (_req, res): void => {
  const status = getBotStatus();
  res.json(status);
});

// GET /api/settings
router.get("/settings", async (_req, res): Promise<void> => {
  try { res.json(await getAllSettings()); }
  catch { res.status(503).json({ error: "Database unavailable" }); }
});

// PATCH /api/settings
router.patch("/settings", async (req, res): Promise<void> => {
  const allowed = [
    "sticker_quality",
    "channel_name",
  ];

  const body = req.body as Record<string, string>;

  for (const key of allowed) {
    if (body[key] !== undefined) {
      await setSetting(key, String(body[key]));
    }
  }

  res.json({ ok: true, settings: await getAllSettings() });
});

export default router;
