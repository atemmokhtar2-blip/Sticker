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
router.get("/settings", (_req, res): void => {
  const settings = getAllSettings();
  res.json(settings);
});

// PATCH /api/settings
router.patch("/settings", (req, res): void => {
  const allowed = [
    "watermark_text",
    "watermark_position",
    "watermark_color",
    "font_size",
    "font_family",
    "watermark_enabled",
    "sticker_quality",
    "channel_name",
  ];

  const body = req.body as Record<string, string>;

  for (const key of allowed) {
    if (body[key] !== undefined) {
      setSetting(key, String(body[key]));
    }
  }

  res.json({ ok: true, settings: getAllSettings() });
});

export default router;
