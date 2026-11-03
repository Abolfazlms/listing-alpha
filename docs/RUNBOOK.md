# Runbook — کارهای عملیاتی

هر سناریو: نشانه، تشخیص، اقدام. دستورهای D1 با `--remote` روی دیتابیس واقعی اجرا می‌شوند.

---

## ۱. کرون اجرا نمی‌شود

**نشانه:** هیچ پیام جدیدی در کانال نیست و `npx wrangler tail` هیچ خطی نشان نمی‌دهد.

**تشخیص:**

```bash
npx wrangler deployments list        # آخرین استقرار موفق بوده؟
npx wrangler tail --format json      # لاگ زنده
```

اگر `tail` هیچ رویدادی نشان نمی‌دهد:

- `wrangler.toml` بخش `[triggers]` را چک کن (`crons = [...]`).
- مطمئن شو Worker روی حساب درستی deploy شده (`npx wrangler whoami`).
- یک‌بار دستی اجرا کن تا مسیر کد را از کرون جدا کنی:

```bash
curl -X POST -H "authorization: Bearer <ADMIN_TOKEN>" \
  https://<worker>/api/v1/admin/poll
```

اگر دستی کار کرد ولی کرون نه، مشکل زمان‌بندی است نه کد. کرون را در پیشخوان
Cloudflare → Workers & Pages → listing-alpha → Settings → Triggers بازبینی کن.

## ۲. یک صرافی صفر آیتم می‌دهد

**نشانه:** در پاسخ `poll`، نام صرافی در `sourcesFailed` است یا تعداد `found` افت کرده.

```bash
npm run check:sources
```

- اگر `FAIL` با ۴۰۳/۴۰۴: اندپوینت عوض شده. در `src/pipeline/sources.js` اندپوینت
  جدید را **اول** لیست اضافه کن (لیست fallback است؛ ترتیب مهم است).
- اگر `0 items` ولی HTTP 200: ساختار JSON عوض شده. `collectItems` عمومی است و اکثر
  تغییرها را تحمل می‌کند؛ اگر نه، کلیدهای تیتر/زمان را در `TITLE_KEYS`/`TIME_KEYS`
  اضافه کن.
- اگر از ایران `FAIL` و از Cloudflare `OK` بود، طبیعی است (DNS فیلتر). ملاک، اجرای
  Worker است نه ماشین تو.
- یک صرافی خراب، بقیه را متوقف نمی‌کند — عمداً.

## ۳. فاکتور پرداخت شده ولی دسترسی داده نشده

**تشخیص:**

```bash
npx wrangler d1 execute listing-alpha --remote --command \
  "SELECT id, amount, status, txid, created_at FROM invoices ORDER BY created_at DESC LIMIT 10"
```

**علت‌های رایج:**

| علامت | معنا | اقدام |
|---|---|---|
| `status=pending` و txid خالی | تراکنش هنوز confirm نشده یا مبلغ دقیق نبوده | ۱۵ دقیقه صبر؛ بعد در Tronscan همان آدرس را ببین |
| مبلغ در Tronscan هست ولی مبلغ فاکتور نیست | کاربر اشتباه فرستاده | دستی اعطا کن (پایین) |
| `status=expired` | بعد از انقضا رسیده | دستی اعطا کن |
| `credited_txids` پر است ولی `entitlements` خالی | خطای نیمه‌کاره | دستی اعطا کن |

**اعطای دستی** (بعد از تأیید در Tronscan):

```sql
UPDATE invoices SET status='paid', paid_at=datetime('now'), txid='<TXID>'
WHERE id='<INVOICE_ID>';

INSERT INTO entitlements (key, plan, invoice_id, created_at, expires_at, telegram_chat, active)
VALUES ('LA-MANUAL-0001', 'month', '<INVOICE_ID>', datetime('now'), datetime('now','+30 days'), '<CHAT_ID>', 1);
```

بعد لینک دعوت کانال خصوصی را دستی در تلگرام بفرست.

## ۴. کاربر می‌گوید «پول فرستادم» ولی چیزی نیست

۱. آدرس و مبلغ را از کاربر بگیر (اسکرین‌شات تراکنش).
۲. در Tronscan آدرس مقصد را جستجو کن و `TxID` را پیدا کن.
۳. اگر `to` درست است ولی مبلغ ±۱۰۰۰ میکرو اختلاف دارد: **اعطا کن**. مبلغ یکتا برای
   تطبیق خودکار است، نه برای سخت‌گیری با مشتری.
۴. تراکنش را در `credited_txids` ثبت کن تا دوباره استفاده نشود.

## ۵. پیام‌های تلگرام ارسال نمی‌شوند

| خطا | علت | اقدام |
|---|---|---|
| `401 Unauthorized` | توکن ربات غلط/باطل | `wrangler secret put TELEGRAM_BOT_TOKEN` |
| `400 chat not found` | شناسه کانال غلط یا ربات ادمین نیست | `getUpdates` و افزودن ربات به‌عنوان ادمین |
| `429 Too Many Requests` | ارسال سریع | کد ۱.۲ ثانیه فاصله دارد؛ اگر باز هم شد، سقف دسته را کم کن |
| `403 bot was blocked` | کاربر ربات را بلاک کرده | کاری نمی‌شود کرد؛ لایسنس را با ایمیل/لینک بفرست |

## ۶. به سقف CPU یا سهمیه خورده‌ام

**نشانه:** در لاگ `exceeded CPU` یا `Error 1102`؛ کرون‌ها نیمه‌کاره می‌مانند.

- تعداد منابع را در دو کرون مختلف تقسیم کن (مثلاً چهار صرافی در `*/5` و چهار تای
  دیگر در `*/7`).
- `pageSize` اندپوینت‌ها را از ۲۰ به ۱۰ کم کن.
- اگر باز هم شد، پلن ۵ دلاری Workers ارزان‌ترین راه است.

## ۷. پاک کردن یک رویداد اشتباه

```sql
DELETE FROM events WHERE id='<ID>';
```

اگر به کانال‌ها هم رفته، پیام تلگرام را دستی حذف کن (ربات ادمین می‌تواند).

## ۸. پشتیبان‌گیری

هفته‌ای یک‌بار (یا قبل از هر تغییر بزرگ):

```bash
npx wrangler d1 export listing-alpha --remote --output backup-$(date +%F).sql
```

فایل را جای امن و بیرون از ریپو نگه دار.

## ۹. چرخش رازها

```bash
npx wrangler secret put ADMIN_TOKEN     # مقدار جدید
```

و همان مقدار را در GitHub Secrets به‌روز کن، وگرنه ورک‌فلوی استقرار در smoke test
شکست می‌خورد (که خوب است — جلوی استقرار خراب را می‌گیرد).

## ۱۰. وقتی تصمیم گرفتی متوقف کنی

1. `npx wrangler delete` (Worker خاموش).
2. پروژه‌ی Pages را حذف کن.
3. یک پیام در کانال: «سرویس متوقف شد» + بازپرداخت متناسب.
4. ریپو را نگه دار؛ همان موتور برای عمودی بعدی به کار می‌آید.
