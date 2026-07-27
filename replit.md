# WhatsApp Sticker Bot

بوت واتساب شخصي يحوّل الصور تلقائياً إلى ملصقات WhatsApp احترافية بجودة عالية.

## Stack
- **Runtime**: Node.js 20 (ESM)
- **Framework**: Express 5
- **WhatsApp**: `@whiskeysockets/baileys` (Pairing Code)
- **DB**: `better-sqlite3` (إعدادات محلية)
- **Image**: `sharp` (WebP 512×512)
- **Monorepo**: pnpm workspaces

## تشغيل على Replit
```
pnpm --filter @workspace/api-server run build
PORT=3000 node --enable-source-maps artifacts/api-server/dist/index.mjs
```
الـ workflow يقوم بذلك تلقائياً.

### الحصول على كود الربط (Pairing Code)
1. شغّل البوت → في الـ logs ستظهر: `WHATSAPP PAIRING CODE: XXXXXXXX`
2. في واتساب: الإعدادات → الأجهزة المرتبطة → ربط جهاز → رابط برقم هاتف → أدخل الكود

### ملاحظة على الجلسات في Replit
- ملفات الجلسة محفوظة في `sessions/` — تُحذف عند إعادة تشغيل Repl
- للحفاظ على الجلسة استخدم Render مع Persistent Disk (انظر أدناه)

## النشر على Render
المشروع جاهز للنشر — ملف `render.yaml` موجود في الجذر.

### خطوات النشر
1. **Render Dashboard** → New → Blueprint
2. اختر هذا الـ repository
3. Render سيقرأ `render.yaml` تلقائياً
4. عدّل `PHONE_NUMBER` في Environment Variables إلى رقمك الدولي (بدون +)
5. بعد النشر: الكود يظهر في Deploy Logs → أدخله في واتساب

### Persistent Disk (موصى به للإنتاج)
- لضمان بقاء الجلسة بعد إعادة النشر، ارفع الخطة إلى **Starter** أو أعلى
- أضف Disk وحدد المسار `/opt/render/project/src/sessions`

## API Endpoints
| Method | Path | الوصف |
|--------|------|-------|
| GET | `/api/healthz` | فحص الصحة |
| GET | `/api/bot/status` | حالة الاتصال + الكود الحالي |
| GET | `/api/settings` | جميع الإعدادات |
| PATCH | `/api/settings` | تعديل الإعدادات |

## User Preferences
- لغة التطوير: عربي
