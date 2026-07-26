# WhatsApp Sticker Bot

بوت واتساب شخصي يحوّل الصور تلقائياً إلى ملصقات WhatsApp احترافية بجودة عالية.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — تشغيل السيرفر والبوت (port 8080)
- الكود الرابط يظهر في الـ logs عند أول تشغيل (بعد ~3 ثواني)
- لإعادة الربط: احذف مجلد `artifacts/api-server/sessions/` وأعد التشغيل

## Stack

- pnpm workspaces، Node.js 24، TypeScript 5.9
- WhatsApp: @whiskeysockets/baileys (Linking Code / Pairing Code)
- Image Processing: sharp (WebP 512×512 + watermark via SVG)
- Settings: better-sqlite3 (SQLite)
- API: Express 5
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/whatsapp.ts` — منطق الاتصال بالواتساب والمعالجة
- `artifacts/api-server/src/bot/image.ts` — تحويل الصور إلى ملصقات WebP + علامة مائية
- `artifacts/api-server/src/bot/settings.ts` — إدارة الإعدادات عبر SQLite
- `artifacts/api-server/data/settings.db` — قاعدة بيانات الإعدادات
- `artifacts/api-server/sessions/` — جلسة الواتساب (لا تحذفها إلا لإعادة الربط)

## Bot Flow

1. أول تشغيل: يولّد كود ربط (8 أرقام/أحرف) يظهر في الـ logs
2. أدخل الكود في واتساب ← الأجهزة المرتبطة ← ربط جهاز ← رابط برقم هاتف
3. بعد الربط: أرسل صورة واحدة أو أكثر
4. ينتظر البوت 3 ثوانٍ بعد آخر صورة، ثم يسأل عن الوصف
5. أرسل الوصف (نص حر: عربي/إنجليزي/إيموجي/أسطر/روابط)
6. يحوّل البوت جميع الصور فوراً ويرسل الملصقات بنفس الوصف

## Settings API

```
GET  /api/settings          — عرض جميع الإعدادات
PATCH /api/settings         — تعديل الإعدادات
GET  /api/bot/status        — حالة الاتصال والكود الحالي
```

### الإعدادات القابلة للتعديل

| المفتاح | الافتراضي | الوصف |
|---------|-----------|-------|
| `watermark_text` | `01044568121` | نص العلامة المائية |
| `watermark_position` | `bottom-right` | الموضع: top-left, top-right, bottom-left, bottom-right, center |
| `watermark_color` | `#FFFFFF` | لون النص (hex) |
| `font_size` | `18` | حجم الخط |
| `font_family` | `Arial` | نوع الخط |
| `watermark_enabled` | `true` | تفعيل/إلغاء العلامة المائية |
| `sticker_quality` | `80` | جودة WebP (1-100) |
| `phone_number` | `201044568121` | الرقم الدولي للحساب |

## Architecture decisions

- Baileys pairing code بدل QR لأنه أسهل استخداماً في السيرفر
- sharp لمعالجة الصور لأنه أسرع وأدق من البدائل
- المعالجة المتوازية (Promise.allSettled) لأكثر من صورة في نفس الوقت
- SQLite للإعدادات لخفة الاستهلاك وعدم الحاجة لقاعدة بيانات خارجية
- الجلسة محفوظة على الملف لضمان الاتصال التلقائي بعد إعادة التشغيل

## User preferences

- بدون لوحة تحكم — بوت فقط

## Gotchas

- احذف `sessions/` فقط عند الحاجة لإعادة الربط من الصفر
- الكود الرابط يظهر في logs بعد ~3 ثواني من التشغيل
- الرقم في `settings.db` يجب بالصيغة الدولية بدون + (مثال: `201044568121`)
- sharp و better-sqlite3 مضافان لقائمة externals في build.mjs
- `sessions/creds.json` و `data/*.db` مستثنيان من git — لا ترفعهم أبداً

## Railway Deployment

راجع `RAILWAY_DEPLOYMENT.md` للتعليمات الكاملة. المتطلبات الأساسية:

| المتغير | الوصف |
|---------|-------|
| `PORT` | مطلوب — Railway يضبطه تلقائياً |
| `PHONE_NUMBER` | مطلوب — رقمك الدولي بدون + (مثال: `201044568121`) |

لضمان بقاء الجلسة بعد إعادة التشغيل: فعّل **Persistent Volume** في Railway وربطه بـ `/app/sessions` و `/app/data`.
