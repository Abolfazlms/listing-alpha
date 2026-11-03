# راه‌اندازی در ۳۰ دقیقه

پیش‌نیاز: Node 20 یا بالاتر، git، حساب GitHub، حساب رایگان Cloudflare، حساب Telegram.
هیچ کارت اعتباری لازم نیست.

> نکته‌ی ایران: پیشخوان Cloudflare و بعضی APIها ممکن است بدون VPN در دسترس نباشند.
> اگر `wrangler login` باز نشد، از توکن API استفاده کن (گام ۳) — آن مسیر معمولاً کار می‌کند.

---

## گام ۱ — ورود به Cloudflare

```bash
cd listing-alpha
npm install
npx wrangler login
```

مرورگر باز می‌شود؛ اجازه بده. بعد بررسی کن:

```bash
npx wrangler whoami
```

`Account ID` را کپی کن (در گام ۷ لازم است).

## گام ۲ — ساخت دیتابیس D1

```bash
npx wrangler d1 create listing-alpha
```

خروجی یک `database_id` می‌دهد. آن را در `wrangler.toml` جای مقدار
`00000000-0000-0000-0000-000000000000` بگذار:

```toml
[[d1_databases]]
binding = "DB"
database_name = "listing-alpha"
database_id = "اینجا-را-عوض-کن"
```

سپس جدول‌ها را بساز (همین دستور در CI هم اجرا می‌شود و idempotent است):

```bash
npx wrangler d1 execute listing-alpha --remote --file=schema.sql --yes
```

## گام ۳ — توکن API برای GitHub Actions

پیشخوان Cloudflare → My Profile → API Tokens → **Create Token** → قالب
**Edit Cloudflare Workers**، و بعد این مجوزها را اضافه کن:

| محدوده | سطح |
|---|---|
| Account → Workers Scripts | Edit |
| Account → Cloudflare Pages | Edit |
| Account → D1 | Edit |
| Account → Account Settings | Read |

توکن را یک‌بار نشان می‌دهد؛ کپی کن و جای امن بگذار. این می‌شود `CLOUDFLARE_API_TOKEN`.

## گام ۴ — ربات و کانال‌های تلگرام

۱. در تلگرام به **@BotFather** پیام بده → `/newbot` → یک نام و یوزرنیم بده → توکن را بگیر.
۲. دو کانال بساز:
   - کانال عمومی رایگان (مثلاً `@listingalpha_free`)
   - کانال خصوصی پولی (لینک دعوت بساز و در `INVITE_LINK` بگذار)
۳. ربات را در **هر دو** کانال ادمین کن (حداقل مجوز: ارسال پیام؛ در کانال خصوصی: دعوت کاربر).
۴. شناسه‌ی عددی کانال‌ها را بگیر: در هر کانال یک پیام بگذار، بعد این را باز کن:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

در پاسخ، `"chat":{"id":-100...}` را بردار. برای کانال، عدد منفی و معمولاً با `-100` شروع می‌شود.

## گام ۵ — کیف پول USDT

یک کیف پول TRC20 بساز (TronLink یا Trust Wallet) و **فقط برای این کسب‌وکار** استفاده کن.
آدرس را در `MERCHANT_TRON_ADDRESS` بگذار.

> هیچ‌وقت کلید خصوصی را در ریپو، GitHub Secrets یا کد نگذار. این سیستم فقط آدرس
> عمومی را می‌خواند و هیچ‌وقت به کلید خصوصی نیاز ندارد.

## گام ۶ — متغیرها و رازها در Workers

در `wrangler.toml` بخش `[vars]` را کامل کن:

```toml
[vars]
PUBLIC_SITE = "https://listing-alpha.<account>.workers.dev"
FREE_CHANNEL = "@listingalpha_free"
PAID_CHANNEL = "-1001234567890"
INVITE_LINK = "https://t.me/+xxxxxxxxxxx"
PAYWALL_DELAY_SEC = "900"
MERCHANT_TRON_ADDRESS = "T..."
```

رازها را جدا و رمزنگاری‌شده بگذار:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # یک رشته تصادفی
npx wrangler secret put ADMIN_TOKEN          # یک UUID تصادفی
# اختیاری، برای سقف بالاتر TronGrid:
npx wrangler secret put TRONGRID_API_KEY
```

توکن ادمین را این‌طور بساز:

```bash
node -e "console.log(crypto.randomUUID())"
```

## گام ۷ — استقرار Worker

```bash
npm run deploy
```

بعد تست:

```bash
# سلامت سرویس
curl https://listing-alpha.<account>.workers.dev/api/v1/health

# یک چرخه‌ی کامل دستی (شامل هشدار تلگرام و تطبیق پرداخت‌ها)
curl -X POST -H "authorization: Bearer <ADMIN_TOKEN>" \
  https://listing-alpha.<account>.workers.dev/api/v1/admin/poll

# رویدادها
curl "https://listing-alpha.<account>.workers.dev/api/v1/events?limit=5"
```

اگر همه چیز درست باشد، از این لحظه کرون هر ۵ دقیقه خودکار اجرا می‌شود.

## گام ۷.۵ — اتصال ربات به فروش

یک بار پس از هر استقرار اجرا کن تا تلگرام بداند پیام‌ها را کجا بفرستد:

```bash
curl -X POST -H "authorization: Bearer <ADMIN_TOKEN>" \
  https://listing-alpha.<account>.workers.dev/api/v1/admin/webhook
```

بعد در تلگرام به ربات `/start` بده. باید منو را ببینی. `/buy month` باید فاکتور بسازد
و `/status` وضعیت را نشان دهد.

> اگر `401` گرفتی، یعنی `TELEGRAM_WEBHOOK_SECRET` ست نشده یا تلگرام هدر محرمانه را
> نمی‌فرستد؛ دوباره `registerWebhook` را صدا بزن (مقدار secret را در همان درخواست
> می‌گذارد).

## گام ۸ — سایت روی Cloudflare Pages

```bash
npx wrangler pages project create listing-alpha --production-branch main
SITE_URL=https://listing-alpha.pages.dev npm run build:site -- --input data/demo-events.json --out dist
npx wrangler pages deploy dist --project-name listing-alpha
```

برای داده‌ی واقعی، اول اسمپشن را از Worker بگیر:

```bash
API_BASE=https://listing-alpha.<account>.workers.dev ADMIN_TOKEN=<...> npm run export
npm run build:site -- --input data/snapshot.json --out dist --site https://listing-alpha.pages.dev
```

برای گزارش با آمار واکنش قیمت (این گام به شبکه نیاز دارد؛ از ایران ممکن است بلاک باشد،
از GitHub Actions کار می‌کند):

```bash
npm run enrich -- --input data/snapshot.json --out data/reactions.json --limit 40
npm run report -- --input data/snapshot.json --out data
```

## گام ۹ — مخزن GitHub و اتوماسیون

```bash
git init && git add . && git commit -m "Listing Alpha: pipeline, worker, site, workflows"
```

مخزن را بساز و push کن. **پیشنهاد: مخزن خصوصی** (۲هزار دقیقه Actions رایگان در ماه
برای این حجم کاملاً کافی است و مزیت رقابتی‌ات عمومی نمی‌شود).

سپس در GitHub → Settings:

**Secrets** (Actions → Secrets → New repository secret):

| نام | مقدار |
|---|---|
| `CLOUDFLARE_API_TOKEN` | توکن گام ۳ |
| `CLOUDFLARE_ACCOUNT_ID` | از `npx wrangler whoami` |
| `ADMIN_TOKEN` | همان UUID گام ۶ |

**Variables** (Actions → Variables):

| نام | مقدار نمونه |
|---|---|
| `API_BASE` | `https://listing-alpha.<account>.workers.dev` |
| `SITE_URL` | `https://listing-alpha.pages.dev` |
| `PAGES_PROJECT` | `listing-alpha` |

بعد Actions → `deploy-worker` → Run workflow. اگر سبز شد، یک‌بار
`deploy-site` را هم اجرا کن.

## گام ۱۰ — بررسی نهایی

```bash
npx wrangler tail          # لاگ زنده؛ باید هر ۵ دقیقه یک خط JSON ببینی
```

چک‌لیست:

- [ ] `/api/v1/health` مقدار `ok: true` می‌دهد
- [ ] `/api/v1/events` حداقل یک رویداد دارد
- [ ] در کانال پولی، پیام هشدار آمده
- [ ] در کانال رایگان، همان پیام با ۱۵ دقیقه تأخیر آمده
- [ ] `POST /api/v1/checkout` یک فاکتور با مبلغ یکتا می‌دهد
- [ ] `npm run check:sources` نشان می‌دهد کدام صرافی‌ها از Cloudflare جواب می‌دهند

## آنچه هنوز دستی است

- **اعطای دسترسی پس از پرداخت** خودکار است، ولی *فروش* دستی است: لینک `/pricing` یا
  فاکتور را در کانال/پست بگذار. هیچ درگاه یا صفحه‌ی پرداخت خودکاری وجود ندارد.
- **بازپرداخت** دستی است (`docs/RUNBOOK.md`).
- **دامنه‌ی اختصاصی** اختیاری است؛ برای شروع با `*.pages.dev` و `*.workers.dev` هم
  می‌شود فروخت، ولی برای اعتماد، دامنه بهتر است.
