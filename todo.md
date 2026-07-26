# Sticker — جاهز للنشر على Railway ✅

## الحالة: مكتمل وجاهز

### التحققات النهائية
- [x] `pnpm install` — نجح (lockfile نظيف)
- [x] `pnpm install --frozen-lockfile` — نجح (متوافق مع Railway)
- [x] `pnpm --filter @workspace/api-server run build` — نجح (dist/index.mjs)
- [x] تشغيل السيرفر — يقلع بنجاح ("Server listening" + "Starting Bot")
- [x] healthcheck `/api/healthz` — متاح

### الإعداد للنشر
- [x] `railway.json` — Nixpacks build + start + healthcheck + PHONE_NUMBER افتراضي
- [x] `package.json` — engines.node >=20, pnpm >=9
- [x] `.gitignore` — sessions/data/dist/node_modules مستثناة
- [x] `.dockerignore` — نظيف
- [x] `README.md` — تعليمات النشر الكاملة

### ما حُذف
- لوحة التحكم (sticker-bot-dashboard, mockup-sandbox)
- lib/api-client-react, lib/api-spec, lib/db
- كل ملفات Replit (.replit, replit.md, replit.nix, .replit-artifact, scripts/)
- railpack.json القديم, RAILWAY_DEPLOYMENT.md
- تبعيات غير مستخدمة (@replit/connectors-sdk)

### الخطوات على Railway
1. New Project → Deploy from GitHub repo ← اختر المستودع
2. (تلقائي) PHONE_NUMBER=201044568121 موجود في railway.json
3. (موصى به) Persistent Volume → /app/sessions + /app/data
4. شاهد Deploy Logs → ستجد `WHATSAPP PAIRING CODE: XXXXXXXX`
