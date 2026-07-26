# WhatsApp Sticker Bot — Railway Deployment

بوت واتساب شخصي يحوّل الصور تلقائياً إلى ملصقات WhatsApp احترافية بجودة عالية.

## النشر على Railway

### المتطلبات
| المتغير | القيمة | ملاحظة |
|---------|--------|--------|
| `PORT` | تلقائي من Railway | مطلوب — Railway تضبطه |
| `PHONE_NUMBER` | `201044568121` | رقمك الدولي بدون `+` — مضبوط افتراضياً في railway.json، أو ضعه في Variables |

### خطوات النشر
1. على Railway: **New Project → Deploy from GitHub repo** ← اختر هذا المستودع.
2. Railway ستقرأ `railway.json` تلقائياً:
   - **البناء**: `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build`
   - **التشغيل**: `node --enable-source-maps artifacts/api-server/dist/index.mjs`
   - **healthcheck**: `/api/healthz`
3. (موصى به) فعّل **Persistent Volume** واربطه بـ `/app/sessions` و `/app/data` لضمان بقاء الجلسة بعد إعادة النشر.

### الحصول على كود الربط (8 خانات)
- عند أول نشر، يظهر **كود الربط** (8 أرقام/أحرف) في **Deploy Logs** بعد ~3 ثوانٍ من بدء التشغيل.
- شكله في الـ log: `WHATSAPP PAIRING CODE: XXXXXXXX — open WhatsApp > Linked Devices > Link a Device > Link with phone number`
- في واتساب: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز ← **رابط برقم هاتف** ← أدخل الكود.

### بعد الربط
- أرسل صورة واحدة أو أكثر في المحادثة مع البوت.
- ينتظر البوت 3 ثوانٍ بعد آخر صورة ثم يسألك عن الوصف.
- أرسل الوصف (نص حر: عربي/إنجليزي/إيموجي/أسطر/روابط).
- يحوّل البوت كل الصور فوراً ويُرسل الملصقات بالوصف نفسه.

### إعادة الربط
احذف محتوى مجلد `sessions/` (عبر Persistent Volume) ثم أعد النشر ليظهر كود جديد.

## التطوير محلياً
```bash
pnpm install
pnpm --filter @workspace/api-server run build
PORT=8080 node --enable-source-maps artifacts/api-server/dist/index.mjs
```

## API
- `GET /api/healthz` — فحص الصحة
- `GET /api/bot/status` — حالة الاتصال + الكود الحالي
- `GET /api/settings` — جميع الإعدادات
- `PATCH /api/settings` — تعديل الإعدادات (watermark_text, watermark_position, watermark_color, font_size, font_family, watermark_enabled, sticker_quality)

## ملاحظات
- يتطلب Node.js 20+ (محدد في `package.json` engines).
- يستخدم `@whiskeysockets/baileys` للاتصال بواتساب (Pairing Code).
- يستخدم `sharp` لتحويل الصور إلى WebP 512×512 + `better-sqlite3` للإعدادات.
- `sessions/` و `data/*.db` تُنشأ وقت التشغيل ولا تُرفع إلى git.
