import { Router, type IRouter } from "express";
import { getBotStatus } from "../bot/whatsapp";
import { getAllSettings, setSetting } from "../bot/settings";

const router: IRouter = Router();

// GET /api/bot/qr — live WhatsApp QR pairing page
router.get("/bot/qr", (_req, res): void => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sticker - ربط واتساب</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101820;color:#f4f7fa;font-family:Arial,sans-serif;padding:20px}
main{width:min(100%,430px);text-align:center;background:#1b2935;border:1px solid #314454;border-radius:20px;padding:28px 20px}
h2{margin:0 0 12px}p{color:#c5d0d8;line-height:1.8}#qr{display:inline-block;background:#fff;padding:14px;border-radius:12px;margin:12px auto;min-width:0}
#status{font-weight:bold;color:#8ee6ad}.hint{font-size:13px;color:#aab8c3}
</style></head>
<body><main><h2>ربط بوت Sticker بواتساب</h2><p id="status">جاري انتظار رمز QR...</p><div id="qr"></div><p id="hint" class="hint">افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح الرمز من شاشة أخرى.</p></main>
<script>
const statusEl=document.getElementById('status'), qrEl=document.getElementById('qr');
let lastQr='';
async function refresh(){
 try{
  const r=await fetch('/api/bot/status',{cache:'no-store'}); const d=await r.json();
  if(d.status==='connected'){statusEl.textContent='✅ واتساب متصل بالفعل';qrEl.innerHTML='';lastQr='';}
  else if(d.qrCode){
   statusEl.textContent='امسح رمز QR من واتساب خلال الوقت المتاح';
   if(lastQr!==d.qrCode){qrEl.innerHTML='';new QRCode(qrEl,{text:d.qrCode,width:260,height:260,correctLevel:QRCode.CorrectLevel.M});lastQr=d.qrCode;}
  }else if(d.linkingCode){statusEl.textContent='كود الربط: '+d.linkingCode;qrEl.innerHTML='';}
  else if(d.pairingError){statusEl.textContent='تعذر بدء الربط: '+d.pairingError;qrEl.innerHTML='';}
  else{statusEl.textContent='جاري تجهيز رمز QR...';}
 }catch(e){statusEl.textContent='تعذر الاتصال بالخادم، جاري إعادة المحاولة...';}
}
refresh();setInterval(refresh,2000);
</script></body></html>`);
});

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
