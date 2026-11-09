import { Router, type IRouter } from "express";
import { getAllSettings, getBotRuntimeState, setSetting } from "../bot/settings";

const router: IRouter = Router();

// GET /api/bot/qr — eight-digit WhatsApp phone pairing code page
router.get("/bot/qr", (_req, res): void => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sticker - ربط واتساب</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101820;color:#f4f7fa;font-family:Arial,sans-serif;padding:20px}
main{width:min(100%,430px);text-align:center;background:#1b2935;border:1px solid #314454;border-radius:20px;padding:28px 20px}
h2{margin:0 0 12px}p{color:#c5d0d8;line-height:1.8}#qr{display:inline-block;background:#fff;padding:14px;border-radius:12px;margin:12px auto;min-width:0}
#status{font-weight:bold;color:#8ee6ad}.hint{font-size:13px;color:#aab8c3}#code{font-size:34px;letter-spacing:8px;font-weight:800;background:#fff;color:#15212b;border-radius:12px;padding:18px 12px;margin:18px auto;direction:ltr;min-height:74px}
</style></head>
<body><main><h2>ربط بوت Sticker بواتساب</h2><p id="status">جاري تجهيز كود الربط...</p><div id="code">•••• ••••</div><p id="hint" class="hint">افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف، ثم أدخل الكود المكوّن من 8 أرقام.</p></main>
<script>
const statusEl=document.getElementById('status'), codeEl=document.getElementById('code');
let lastCode='';
async function refresh(){
 try{
  const r=await fetch('/api/bot/status',{cache:'no-store'}); const d=await r.json();
  if(d.status==='connected'){statusEl.textContent='✅ واتساب متصل بالفعل';codeEl.textContent='متصل';lastCode='';}
  else if(d.linkingCode){
   statusEl.textContent='أدخل الكود التالي في واتساب الآن';
   const formatted=String(d.linkingCode).replace(/[^0-9]/g,'');
   codeEl.textContent=formatted.length===8?formatted.slice(0,4)+' '+formatted.slice(4):formatted;
   lastCode=formatted;
  }else if(d.pairingError){statusEl.textContent='تعذر إنشاء كود الربط: '+d.pairingError;codeEl.textContent='';}
  else if(d.hasRegisteredSession){statusEl.textContent='تم العثور على جلسة محفوظة. حالة الاتصال: '+d.status+(d.lastDisconnectCode?' — '+d.lastDisconnectCode:'');codeEl.textContent='';}
  else{statusEl.textContent='جاري الاتصال بخوادم واتساب وتجهيز كود من 8 أرقام...';codeEl.textContent='•••• ••••';}
 }catch(e){statusEl.textContent='تعذر الاتصال بالخادم، جاري إعادة المحاولة...';}
}
refresh();setInterval(refresh,1500);
</script></body></html>`);
});

// GET /api/bot/status
router.get("/bot/status", async (_req, res): Promise<void> => {
  try { res.json(await getBotRuntimeState()); }
  catch { res.status(503).json({ error: "Bot status unavailable" }); }
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
