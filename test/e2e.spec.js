// Playwright: extraction → decide() → badge, in a real browser, with no network.
//
// This covers exactly what bun test cannot: reading a real HTML page, and getting a
// badge into a merchant's DOM without the merchant's CSS eating it. Both bugs that
// actually shipped were in that gap — `all:initial` declared last reset the badge's
// own `position:fixed`, and `all:unset` on `button` clobbered `[hidden]`'s
// `display:none` so "copy receipt" showed in link-only.
//
// decide() is the REAL function, called through an exposed binding rather than
// stubbed. A test that hardcodes the verdict proves the renderer works and says
// nothing about whether the policy does.
//
// Run: bunx playwright test
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { decide, markupPercent, parsePrice } from '../src/lib.js';

const receiptJs = readFileSync(new URL('../src/receipt.js', import.meta.url), 'utf8');
const contentJs = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

// A Shopify product page reduced to the fields extract() actually reads. Notably it
// publishes og:price:* and no ld+json — measured on warmlydecor, which is why the
// og fallback exists at all.
function pageHtml({ title, price, currency, vendor }) {
  return `<!doctype html><html><head>
    <meta id="shopify-digital-wallet" content="/1/digital_wallets/dialog">
    <meta property="og:price:amount" content="${price}">
    <meta property="og:price:currency" content="${currency}">
    <title>${title}</title>
  </head><body>
    <h1>${title}</h1>
    <div class="price">from $1.00</div>
    <img src="https://cdn.shopify.com/s/files/1/0/0/decoy.jpg" alt="recommendation">
  </body></html>`;
}

function productJson({ title, price, currency, vendor }) {
  return JSON.stringify({
    title, vendor, currency,
    variants: [{ id: 1, price: String(Math.round(price * 100)), featured_image: null }],
    images: ['//cdn.shopify.com/s/files/1/0/0/hero.jpg'],
  });
}

// Everything the worker adds on top of decide(). Kept here rather than imported
// because it lives in worker.js behind chrome.* — but it is only field shuffling.
function dress(extraction, verdict) {
  const out = { render: verdict.render, reasons: verdict.reasons, note: verdict.note || null };
  if (verdict.winner) {
    const ali = parsePrice(verdict.winner.price);
    Object.assign(out, {
      aliPrice: ali, aliCurrency: verdict.winner.currency, aliUrl: verdict.winner.url,
      aliTitle: verdict.winner.title, aliImage: verdict.winner.image, sold: verdict.winner.sold,
      markup: ali ? markupPercent(extraction.price, ali) : null,
      shipTo: 'US', capturedAt: '2026-07-27',
    });
  }
  return out;
}

async function loadProduct(page, product, results, host = 'shop.example.com') {
  const seen = [];

  await page.route('**/products/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('.js')) {
      return route.fulfill({ contentType: 'application/json', body: productJson(product) });
    }
    return route.fulfill({ contentType: 'text/html', body: pageHtml(product) });
  });
  // The badge must never depend on an image actually loading.
  await page.route('**/cdn.shopify.com/**', (r) => r.abort());

  // The real policy, over fixture results. The page hands us its extraction; nothing
  // about the verdict is hardcoded in the test.
  await page.exposeFunction('__lookup', (extraction) => {
    seen.push(extraction);
    return dress(extraction, decide(extraction, results, null));
  });

  await page.addInitScript(() => {
    window.chrome = {
      storage: { local: { get: () => Promise.resolve({ alibadgeDebug: false }) } },
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: (msg, cb) => {
          if (msg.type === 'firstRunSeen') return cb({ first: false });
          if (msg.type === 'lookup') return window.__lookup(msg.extraction).then(cb);
          return cb(null);
        },
      },
    };
  });

  await page.goto(`https://${host}/products/thing`);
  await page.addScriptTag({ content: receiptJs });
  await page.addScriptTag({ content: contentJs });
  return seen;
}

const CHEAP = [{
  productId: '1', price: '$9.72', currency: 'USD', sold: '180 sold',
  title: 'Luxury Gold Stainless Steel Cutlery Set 24pc',
  url: 'https://www.aliexpress.com/item/32930388619.html',
  image: 'https://ae01.alicdn.com/kf/x.jpg',
}];

const badge = (page) => page.locator('#alibadge-root');

test('fires on a dropship product and shows the markup', async ({ page }) => {
  await loadProduct(page, {
    title: 'Royal Vintage Cutlery Set', price: 84.95, currency: 'USD', vendor: 'WarmlyDecor',
  }, CHEAP);

  await expect(badge(page)).toBeAttached({ timeout: 15000 });
  const root = badge(page);
  await expect(root.locator('[data-mk]')).toHaveText('+774%');
  await expect(root.locator('[data-copy]')).toBeVisible();

  // The badge must survive the page's own CSS. A static host renders at the end of
  // <body> where nobody sees it, which is how this shipped broken once.
  const pos = await root.evaluate((el) => getComputedStyle(el).position);
  expect(pos).toBe('fixed');
});

test('reads the canonical price, not the first .price in the DOM', async ({ page }) => {
  // A loose `.price` selector matched a recommendation card and returned a different
  // product's number on a real page. The fixture plants that decoy.
  const seen = await loadProduct(page, {
    title: 'Royal Vintage Cutlery Set', price: 84.95, currency: 'USD', vendor: 'WarmlyDecor',
  }, CHEAP);
  await expect(badge(page)).toBeAttached({ timeout: 15000 });
  expect(seen[0].price).toBe(84.95);
  expect(seen[0].currency).toBe('USD');
  expect(seen[0].vendor).toBe('WarmlyDecor');
});

test('HARD NEGATIVE: goes silent, and for the named reason', async ({ page }) => {
  // $400 against a $20 listing. 20x on a price that high means the MATCH is wrong,
  // not that the markup is large — the one class no caveat repairs.
  //
  // Asserting absence alone would PASS with brandGuard deleted, which is why the
  // reason is asserted too. That is the whole point of this test.
  const results = [{
    productId: '1', price: '$20', currency: 'USD', title: 'Generic Tumbler',
    url: 'https://www.aliexpress.com/item/1.html', image: 'https://ae01.alicdn.com/kf/y.jpg',
  }];
  const seen = await loadProduct(page, {
    title: 'Stanley Quencher 40oz', price: 400, currency: 'USD', vendor: 'Stanley',
  }, results);

  // Wait for the pipeline to have RUN (the page asked), then settle. Asserting
  // count 0 immediately would pass before the badge ever had a chance to appear.
  await expect.poll(() => seen.length, { timeout: 15000 }).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  await expect(badge(page)).toHaveCount(0);

  const verdict = decide(seen[0], results, null);
  expect(verdict.render).toBe('none');
  expect(verdict.reasons).toContain('ratio_implausible');
});

test('a brand caveat renders WITH the number instead of suppressing it', async ({ page }) => {
  // The i-cell case: suppressing this discarded a genuinely cheaper listing for the
  // same item. The number shows; the caveat shows with it.
  // Host matters: vendor is the shop's OWN name here, so the vendor path must stay
  // quiet and the brand token in the title must be what speaks. Ran first against a
  // generic fixture host and got 'listing does not name iCell' — correct behaviour
  // for a vendor that does not resemble the domain, wrong fixture for this case.
  await loadProduct(page, {
    title: 'Otterbox Symmetry Folio for iPad Air 11', price: 299, currency: 'USD', vendor: 'iCell',
  }, [{
    productId: '1', price: '$44.60', currency: 'USD', title: 'Shockproof Folio Case for iPad Air 11',
    url: 'https://www.aliexpress.com/item/2.html', image: 'https://ae01.alicdn.com/kf/z.jpg',
  }], 'www.i-cell.co.il');

  await expect(badge(page)).toBeAttached({ timeout: 15000 });
  await expect(badge(page).locator('[data-mk]')).toHaveText('+570%');
  await expect(badge(page).locator('[data-sub]')).toContainText('otterbox is a brand name');
});

test('skips a non-product path without touching the network', async ({ page }) => {
  await page.route('**/collections/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>All</h1>' }));
  await page.addInitScript(() => {
    window.chrome = {
      storage: { local: { get: () => Promise.resolve({}) } },
      runtime: {
        onMessage: { addListener: () => {} },
        sendMessage: (m, cb) => { window.__asked = true; cb(null); },
      },
    };
  });
  await page.goto('https://shop.example.com/collections/all');
  await page.addScriptTag({ content: receiptJs });
  await page.addScriptTag({ content: contentJs });
  await expect(badge(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__asked)).toBeUndefined();
});
