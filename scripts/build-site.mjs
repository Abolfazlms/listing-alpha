#!/usr/bin/env node
/**
 * Static site generator.
 *
 * The public site is the acquisition channel: long-tail search traffic for
 * "exchange listing" queries, plus a public record that makes the paid tier
 * credible. Generated from a snapshot, no runtime, no framework, no build
 * dependencies — Cloudflare Pages serves the output directly.
 *
 *   node scripts/build-site.mjs --input data/snapshot.json --out dist \
 *        --site https://listing-alpha.pages.dev
 */

import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { summarize, formatLatency } from '../src/lib/stats.js';
import { PLANS } from '../src/worker/payments.js';

const args = parseArgs(process.argv.slice(2));
const inputPath = args.input || 'data/snapshot.json';
const outDir = args.out || 'dist';
const site = (args.site || process.env.SITE_URL || 'https://listing-alpha.pages.dev').replace(/\/$/, '');
const buildDate = new Date();

if (!existsSync(inputPath)) {
  console.error(`No snapshot at ${inputPath}. Run: npm run export  (or: node scripts/build-site.mjs --input data/demo-events.json)`);
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(inputPath, 'utf8'));
const events = (snapshot.events || []).slice().sort((a, b) => String(b.announced_at).localeCompare(String(a.announced_at)));
const summary = summarize(events);

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, 'events'), { recursive: true });
mkdirSync(join(outDir, 'exchanges'), { recursive: true });

/* --------------------------------- utils -------------------------------- */

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const shortDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso).slice(0, 10)
    : d.toISOString().slice(0, 10);
};

/**
 * JSON-LD is injected inside a <script> element, so any "<" in the data would
 * end the block early and let an announcement title inject markup. Escaping
 * the dangerous code points keeps the JSON valid *and* inert.
 */
const safeJsonLd = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

function page({ title, description, path, body, jsonLd }) {
  const canonical = `${site}${path}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="application/rss+xml" title="Listing Alpha" href="/rss.xml">
<link rel="stylesheet" href="/style.css">
${jsonLd ? `<script type="application/ld+json">${safeJsonLd(jsonLd)}</script>` : ''}
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">Listing<span>Alpha</span></a>
  <nav>
    <a href="/stats.html">Stats</a>
    <a href="/pricing.html">Pricing</a>
    <a href="/rss.xml">RSS</a>
  </nav>
</header>
<main>
${body}
</main>
<footer>
  <p>Listing Alpha tracks exchange announcements and measures detection latency. Not investment advice.</p>
  <p><a href="/api/v1/health">API</a> · <a href="/pricing.html">Instant alerts</a> · built ${buildDate.toISOString().slice(0, 10)}</p>
</footer>
</body>
</html>`;
}

function eventRow(event) {
  const tier = event.meta?.tier || '-';
  return `<tr>
    <td class="score t${esc(tier)}">${esc(tier)}<span>${esc(event.score ?? 0)}</span></td>
    <td class="sym"><a href="/events/${esc(event.id)}.html">${esc(event.symbol || '—')}</a></td>
    <td class="ex">${esc(event.source)}</td>
    <td class="kind k-${esc(String(event.kind).toLowerCase())}">${esc(event.kind)}</td>
    <td class="lat">${esc(formatLatency(event.latency_sec))}</td>
    <td class="ttl">${esc(String(event.title).slice(0, 96))}</td>
    <td class="d">${esc(shortDate(event.announced_at))}</td>
  </tr>`;
}

function table(rows) {
  return `<div class="tablewrap"><table>
  <thead><tr><th>Tier</th><th>Symbol</th><th>Venue</th><th>Type</th><th>Detected</th><th>Announcement</th><th>Date</th></tr></thead>
  <tbody>${rows.join('')}</tbody>
</table></div>`;
}

/* -------------------------------- index -------------------------------- */

const latest = events.slice(0, 60);
const indexBody = `
<section class="hero">
  <h1>Which crypto listings actually matter?</h1>
  <p class="lede">Every announcement from ${summary.bySource.length} exchanges, deduplicated, scored, and timestamped with how fast it was detected. Free feed is delayed by 15 minutes.</p>
  <div class="strip">
    <div><b>${summary.total}</b><span>events tracked</span></div>
    <div><b>${formatLatency(summary.avgLatency)}</b><span>avg detection</span></div>
    <div><b>${summary.byKind.LISTING || 0}</b><span>spot listings</span></div>
    <div><b>${summary.byKind.DELISTING || 0}</b><span>delistings</span></div>
  </div>
</section>
<h2>Latest activity</h2>
${table(latest.map(eventRow))}
<h2>Venues covered</h2>
<ul class="venues">
${summary.bySource.map((s) => `<li><a href="/exchanges/${esc(s.source)}.html">${esc(s.source)}</a> <span>${s.count} events · ${s.listings} listings · ${formatLatency(s.avgLatency)} avg</span></li>`).join('\n')}
</ul>
<p class="cta">Get these alerts in Telegram the second they publish. <a href="/pricing.html">See pricing →</a></p>
`;

writeFileSync(
  join(outDir, 'index.html'),
  page({
    title: 'Crypto Exchange Listings — Real-Time Announcement Tracker | Listing Alpha',
    description: `Live tracker of new crypto exchange listings, delistings and perpetual launches across ${summary.bySource.length} exchanges, with detection latency and a signal score.`,
    path: '/',
    body: indexBody,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Recent crypto exchange listing announcements',
      numberOfItems: latest.length,
      itemListElement: latest.slice(0, 20).map((event, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: event.title,
        url: `${site}/events/${event.id}.html`,
      })),
    },
  })
);

/* -------------------------------- events -------------------------------- */

for (const event of events.slice(0, 500)) {
  const related = events.filter((e) => e.symbol && e.symbol === event.symbol && e.id !== event.id).slice(0, 6);
  const body = `
<article class="event">
  <p class="crumbs"><a href="/">Home</a> / <a href="/exchanges/${esc(event.source)}.html">${esc(event.source)}</a> / ${esc(event.kind)}</p>
  <h1>${esc(event.title)}</h1>
  <dl class="facts">
    <div><dt>Symbol</dt><dd>${esc(event.symbol || 'unknown')}</dd></div>
    <div><dt>Venue</dt><dd>${esc(event.source)}</dd></div>
    <div><dt>Type</dt><dd>${esc(event.kind)}</dd></div>
    <div><dt>Signal</dt><dd>${esc(event.meta?.tier || '-')} · ${esc(event.score ?? 0)}/100</dd></div>
    <div><dt>Announced</dt><dd>${esc(String(event.announced_at).replace('T', ' ').slice(0, 16))} UTC</dd></div>
    <div><dt>Detected</dt><dd>${esc(formatLatency(event.latency_sec))} later</dd></div>
  </dl>
  <p class="why"><b>Why it scored ${esc(event.score ?? 0)}:</b> ${esc((event.reasons || []).join(', ') || 'routine announcement')}.</p>
  ${event.url ? `<p><a href="${esc(event.url)}" rel="nofollow noopener">Original announcement ↗</a></p>` : ''}
  ${related.length ? `<h2>Other venues listing ${esc(event.symbol)}</h2><ul class="venues">${related.map((r) => `<li><a href="/events/${esc(r.id)}.html">${esc(r.title)}</a> <span>${esc(r.source)} · ${esc(formatLatency(r.latency_sec))}</span></li>`).join('')}</ul>` : ''}
  <p class="cta">Subscribe for instant delivery: <a href="/pricing.html">Telegram alerts →</a></p>
</article>`;

  writeFileSync(
    join(outDir, 'events', `${event.id}.html`),
    page({
      title: `${event.title} — ${event.source} ${String(event.kind).toLowerCase()}`,
      description: `${event.source} announced: ${event.title}. Detected in ${formatLatency(event.latency_sec)}. Signal score ${event.score}/100.`,
      path: `/events/${event.id}.html`,
      body,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'NewsArticle',
        headline: event.title,
        datePublished: event.announced_at,
        dateModified: event.first_seen_at,
        publisher: { '@type': 'Organization', name: 'Listing Alpha' },
        mainEntityOfPage: `${site}/events/${event.id}.html`,
      },
    })
  );
}

/* ------------------------------- exchanges ------------------------------ */

for (const venue of summary.bySource) {
  const rows = events.filter((e) => e.source === venue.source).slice(0, 100);
  const body = `
<h1>${esc(venue.source)} listing announcements</h1>
<p class="lede">${venue.count} announcements recorded · ${venue.listings} spot listings · median-quality detection in ${formatLatency(venue.avgLatency)}.</p>
${table(rows.map(eventRow))}
<p class="cta"><a href="/pricing.html">Get ${esc(venue.source)} alerts instantly →</a></p>`;
  writeFileSync(
    join(outDir, 'exchanges', `${venue.source}.html`),
    page({
      title: `${venue.source} New Listings — Tracker & History | Listing Alpha`,
      description: `Every ${venue.source} listing, delisting and perpetual announcement we detected, with timestamps and signal scores.`,
      path: `/exchanges/${venue.source}.html`,
      body,
    })
  );
}

/* --------------------------------- stats -------------------------------- */

const statsBody = `
<h1>Detection statistics</h1>
<p class="lede">How fast each venue's announcements are picked up, and how the signal score distributes. Updated with every build.</p>
<h2>By venue</h2>
${table(
  summary.bySource.map(
    (s) => `<tr><td class="score">#</td><td class="sym">${esc(s.source)}</td><td class="ex">${s.count} events</td><td class="kind">${s.listings} listings</td><td class="lat">${esc(formatLatency(s.avgLatency))}</td><td class="ttl" colspan="2">average detection latency</td></tr>`
  )
)}
<h2>By type</h2>
<ul class="venues">
${Object.entries(summary.byKind).map(([kind, count]) => `<li>${esc(kind)} <span>${count}</span></li>`).join('')}
</ul>
<h2>Most active symbols</h2>
<ul class="venues">
${summary.topSymbols.map((s) => `<li>${esc(s.symbol)} <span>${s.count} announcements</span></li>`).join('')}
</ul>`;

writeFileSync(
  join(outDir, 'stats.html'),
  page({
    title: 'Exchange Listing Detection Statistics | Listing Alpha',
    description: 'Per-venue detection latency and announcement volume for crypto exchange listings.',
    path: '/stats.html',
    body: statsBody,
  })
);

/* -------------------------------- pricing ------------------------------- */

const planCards = Object.values(PLANS)
  .map(
    (plan) => `<div class="card${plan.id === 'quarter' ? ' featured' : ''}">
    <h3>${esc(plan.label)}</h3>
    <p class="price">${plan.priceUsdt} <small>USDT</small></p>
    <p class="muted">${plan.days ? `${plan.days} days` : 'one payment, forever'}</p>
    <ul>
      <li>Instant Telegram alerts (no 15-minute delay)</li>
      <li>Full announcement archive + event API key</li>
      <li>Listing reaction statistics</li>
    </ul>
  </div>`
  )
  .join('');

const pricingBody = `
<h1>Pricing</h1>
<p class="lede">One payment in USDT (TRC20). No card, no account, no subscription traps — the licence key arrives in Telegram the moment the transfer confirms.</p>
<div class="cards">${planCards}</div>
<h2>Why USDT</h2>
<p>Card processors and merchant-of-record providers do not serve every country, and the audience for this product already holds stablecoins. A unique micro-amount on each invoice makes the on-chain transfer self-identifying, so access is granted automatically without an account or an email.</p>
<h2>What the free tier includes</h2>
<p>The full event list for the last 7 days, delayed by 15 minutes in Telegram. The paid tier removes both limits and adds the API key.</p>
<p class="cta">Start in Telegram: <code>/buy</code></p>`;

writeFileSync(
  join(outDir, 'pricing.html'),
  page({
    title: 'Pricing — Instant Exchange Listing Alerts in USDT | Listing Alpha',
    description: 'Instant crypto exchange listing alerts in Telegram, paid in USDT TRC20. Monthly, quarterly and lifetime licences.',
    path: '/pricing.html',
    body: pricingBody,
  })
);

/* ---------------------------- feeds and meta ---------------------------- */

const urls = [
  '/',
  '/stats.html',
  '/pricing.html',
  ...summary.bySource.map((s) => `/exchanges/${s.source}.html`),
  ...events.slice(0, 500).map((e) => `/events/${e.id}.html`),
];

writeFileSync(
  join(outDir, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${site}${u}</loc><lastmod>${buildDate.toISOString().slice(0, 10)}</lastmod></url>`).join('\n')}
</urlset>`
);

writeFileSync(
  join(outDir, 'robots.txt'),
  `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`
);

const rssItems = events
  .slice(0, 40)
  .map(
    (event) => `    <item>
      <title>${esc(event.title)}</title>
      <link>${site}/events/${event.id}.html</link>
      <guid>${site}/events/${event.id}.html</guid>
      <pubDate>${new Date(event.announced_at).toUTCString()}</pubDate>
      <description>${esc(`${event.source} ${event.kind} ${event.symbol || ''} — detected in ${formatLatency(event.latency_sec)}, score ${event.score}`)}</description>
    </item>`
  )
  .join('\n');

writeFileSync(
  join(outDir, 'rss.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Listing Alpha</title>
  <link>${site}/</link>
  <description>New crypto exchange listings, delistings and perpetual launches.</description>
  <lastBuildDate>${buildDate.toUTCString()}</lastBuildDate>
${rssItems}
</channel></rss>`
);

writeFileSync(
  join(outDir, '404.html'),
  page({ title: 'Not found', description: 'Page not found', path: '/404.html', body: '<h1>404</h1><p><a href="/">Back to the tracker</a></p>' })
);

if (existsSync('site/styles.css')) {
  mkdirSync(join(outDir), { recursive: true });
  copyFileSync('site/styles.css', join(outDir, 'style.css'));
}
if (existsSync('site/_headers')) copyFileSync('site/_headers', join(outDir, '_headers'));
if (existsSync('site/_redirects')) copyFileSync('site/_redirects', join(outDir, '_redirects'));

console.log(`built ${urls.length} pages -> ${outDir}`);
console.log(`  events: ${events.length}   venues: ${summary.bySource.length}   avg latency: ${formatLatency(summary.avgLatency)}`);

/* ------------------------------- helpers -------------------------------- */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}
