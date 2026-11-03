# Listing Alpha

> Exchange listing intelligence as a product: a pipeline that detects announcements
> across eight venues, scores them, alerts a paying Telegram tier in seconds, and
> publishes a free SEO surface + a weekly paid report.

**Status: working vertical slice.** 25 tests green, offline demo runs end to end, site
builds, workflows written. Nothing is deployed yet — deployment is ~30 minutes of
setup, see `docs/SETUP.md`.

---

## Why this shape

The brief was "build it on GitHub Actions". Two facts forced a different split, both
documented in `docs/LEGAL.md`:

1. GitHub Actions may **not** be the runtime of a commercial service, and scheduled
   workflows in public repos are disabled after 60 days of inactivity.
2. GitHub Pages may **not** host an online business.

So GitHub Actions is the **factory** (test, build, deploy, publish) and Cloudflare
Workers + D1 + Pages is the **runtime** — free tier, no credit card, cron triggers,
and outside the network boundary that blocks several exchanges from Iran.

```
        ┌────────────────────────── GitHub Actions (factory) ─────────────────────────┐
        │  ci.yml            test + demo + site preview on every PR                   │
        │  deploy-worker.yml schema migrate → wrangler deploy → live smoke test        │
        │  deploy-site.yml   snapshot export → static build → Cloudflare Pages         │
        │  weekly-report.yml report + CSV → GitHub Release (the paid artefact)         │
        └───────────────────────────────────┬────────────────────────────────────────┘
                                            │ deploys
                    ┌───────────────────────▼────────────────────────┐
                    │ Cloudflare Worker (runtime, cron every 5 min)  │
                    │  poll 8 venues → normalise → dedupe → score    │
                    │  → paid Telegram channel → settle USDT invoices│
                    │  → free channel after PAYWALL_DELAY_SEC        │
                    └───────────────────────┬────────────────────────┘
                                            │ D1
                    ┌───────────────────────▼────────────────────────┐
                    │ events · seen_symbols · invoices · entitlements │
                    └────────────────────────────────────────────────┘
```

## What is implemented

| Area | File | Notes |
|---|---|---|
| Venue adapters | `src/pipeline/sources.js` | 8 exchanges, multi-endpoint failover, HTML fallback, generic JSON collector |
| Normalisation | `src/pipeline/normalize.js` | kind classification, ticker extraction with blacklist, UTC-safe timestamps |
| Scoring | `src/pipeline/score.js` | explainable 0–100, tier A–D |
| Persistence | `src/pipeline/store.js` | D1 queries, idempotent inserts, invoice/entitlement lifecycle |
| Money | `src/worker/payments.js` | unique-amount USDT (TRC20) invoicing, on-chain matching, replay protection |
| Delivery | `src/worker/notify.js` | Telegram formatting, paid/free broadcast |
| Loop | `src/worker/loop.js` | poll cycle + delayed free flush |
| API | `src/worker/api.js` | events, stats, pricing, checkout, invoice status, admin export/poll |
| Site | `scripts/build-site.mjs` | 22 pages from fixtures: events, venues, stats, pricing, sitemap, RSS, JSON-LD |
| Report | `scripts/build-report.mjs` | Markdown report + CSV dataset |
| Ops | `scripts/check-sources.mjs` | tells you which venue endpoints actually answer |

## Quickstart (no accounts needed)

```bash
npm install          # only devDependency is wrangler
npm test             # 25 tests
npm run demo         # full pipeline over recorded payloads + payment matcher
npm run build:site -- --input data/demo-events.json --out dist
npm run report -- --input data/demo-events.json --out data
```

The demo needs no network, no Cloudflare account and no database. It prints exactly
what a paid subscriber and a free subscriber would each receive.

## Deploy

Follow `docs/SETUP.md` (Cloudflare → D1 → Telegram bot → secrets → GitHub). Then:

```bash
npm run deploy       # wrangler deploy
npm run db:init      # apply schema remotely
```

## Docs

- `docs/DECISION.md` — why this business, what was rejected, unit economics, kill criteria
- `docs/SETUP.md` — 30-minute deployment checklist
- `docs/GTM.md` — how the first 10 paying customers are supposed to happen
- `docs/RUNBOOK.md` — what to do when a feed breaks or a payment does not match
- `docs/LEGAL.md` — the GitHub ToS constraints, scraping ethics, sanctions reality

## Honest expectation

With <5h/week and no capital, the median outcome is **$0**. This repo is designed so that
the experiment costs ~2 weeks of evenings, and so that the *same* pipeline can be
re-pointed at another vertical (token unlocks, regulatory notices, tender feeds) if
crypto listings do not convert. See the kill criteria in `docs/DECISION.md` before
spending more than that.

MIT licensed. Not investment advice.
