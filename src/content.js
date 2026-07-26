// Content script. Self-contained on purpose: content scripts cannot use ES imports,
// and keeping the pure logic in the worker means it is never duplicated here.
// This file only extracts, renders, and tears down.
(() => {
  const PRODUCT_PATH = /^\/products\/[^/]+\/?$/;
  const HOST = location.hostname;

  let generation = 0;
  let badge = null;
  let debug = false;
  chrome.storage.local.get('alibadgeDebug').then((r) => (debug = !!r.alibadgeDebug));
  const log = (...a) => debug && console.log('[alibadge]', ...a);

  const ask = (msg) =>
    new Promise((resolve) => {
      let done = false;
      // If the worker dies mid-pipeline the promise never settles and the badge
      // never appears — indistinguishable from correct silence. Time it out.
      const timer = setTimeout(() => {
        if (!done) { done = true; log('worker timeout'); resolve(null); }
      }, 25000);
      try {
        chrome.runtime.sendMessage({ target: 'worker', ...msg }, (res) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(res || null);
        });
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });

  // --- extraction ------------------------------------------------------------

  function isShopify() {
    if (document.querySelector('meta[id="shopify-digital-wallet"]')) return true;
    return !!document.querySelector('img[src*="cdn.shopify.com"], link[href*="cdn.shopify.com"]');
  }

  function domPriceText() {
    // Independent check that the extracted price is the one on screen. Catches
    // currency mismatches AND variant-selection bugs in one comparison.
    const sel = [
      '[data-price]', '.price__current', '.price-item--sale', '.price-item--regular',
      '.product__price', '.price', '[class*="ProductPrice"]',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      const t = el && el.textContent && el.textContent.trim();
      if (t && /\d/.test(t)) return t;
    }
    const og = document.querySelector('meta[property="product:price:amount"]');
    return og ? og.getAttribute('content') : null;
  }

  function numbersIn(str) {
    const m = String(str || '').match(/\d[\d,]*(?:\.\d+)?/g);
    return m ? m.map((n) => parseFloat(n.replace(/,/g, ''))).filter((n) => n > 0) : [];
  }

  async function extract() {
    if (!PRODUCT_PATH.test(location.pathname)) return { skip: 'not_a_product_path' };
    if (!isShopify()) return { skip: 'not_shopify' };

    // credentials same-origin is REQUIRED: Shopify Markets presentment currency is
    // cookie-driven, and omitting them can return the shop's default-currency price
    // instead of the one the shopper is looking at.
    const res = await fetch(location.pathname.replace(/\/$/, '') + '.js', { credentials: 'same-origin' });
    if (!res.ok) return { skip: 'product_json_' + res.status };
    const ct = res.headers.get('content-type') || '';
    if (!/json|javascript/.test(ct)) return { skip: 'product_json_not_json' };
    const p = await res.json().catch(() => null);
    if (!p || !Array.isArray(p.variants)) return { skip: 'product_json_malformed' };

    const wanted = new URLSearchParams(location.search).get('variant')
      || (document.querySelector('[name="id"]') || {}).value;
    const variant = (wanted && p.variants.find((v) => String(v.id) === String(wanted))) || p.variants[0];
    if (!variant) return { skip: 'no_variant' };

    // price, never compare_at_price: compare_at is the struck-through "was" figure
    // and inflates markup on exactly the stores running permanent fake sales.
    const price = parseInt(variant.price, 10) / 100;
    if (!Number.isFinite(price) || price <= 0) return { skip: 'no_price' };

    // Currency from the JSON or a meta tag — NOT window.Shopify, which is a page
    // global and invisible from this isolated world.
    const currency =
      p.currency ||
      (document.querySelector('meta[property="product:price:currency"]') || {}).content ||
      (document.querySelector('form[action*="/cart"] [name="currency"]') || {}).value ||
      null;

    const domTxt = domPriceText();
    if (domTxt) {
      const seen = numbersIn(domTxt);
      const ok = seen.some((n) => Math.abs(n - price) < Math.max(0.02, price * 0.02));
      if (!ok) return { skip: 'dom_price_mismatch', detail: { price, domTxt } };
    }

    const image = variant.featured_image?.src || p.images?.[0] || p.featured_image || null;
    if (!image) return { skip: 'no_image' };

    return {
      url: location.href,
      host: HOST,
      title: p.title || '',
      price,
      currency,
      image: image.startsWith('//') ? 'https:' + image : image,
    };
  }

  // --- badge -----------------------------------------------------------------

  function teardown() {
    // The generation counter stops a late RESULT from rendering; only this stops
    // product A's markup sitting on product B's page.
    if (badge) { badge.remove(); badge = null; }
  }

  function mount() {
    teardown();
    const host = document.createElement('div');
    host.id = 'alibadge-root';
    // Not bottom-right: nearly every Shopify store puts a chat widget there.
    // Logical properties so RTL mirrors automatically (Hebrew stores exist).
    host.style.cssText =
      'position:fixed;bottom:20px;inset-inline-start:20px;z-index:2147483000;' +
      'all:initial;contain:layout style;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{all:initial}
      .b{box-sizing:border-box;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
         /* reserve the FULL footprint now: it is not our page to reflow later */
         min-width:236px;min-height:74px;display:flex;flex-direction:column;gap:4px;
         background:#12100e;color:#f6f4f1;border:1px solid #3a352f;border-radius:8px;
         padding:10px 12px;box-shadow:0 2px 12px rgba(0,0,0,.28);direction:ltr}
      .row{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
      .mk{font-size:26px;line-height:1;font-weight:700;font-variant-numeric:tabular-nums;color:#ff5a4d}
      .mk.pending{color:#6f6862}
      .ali{font-size:13px;font-variant-numeric:tabular-nums;color:#f6f4f1}
      .sub{font-size:10px;color:#9b938b;letter-spacing:.02em}
      a{color:#8fc7ff;text-decoration:underline;font-size:11px}
      .acts{display:flex;gap:10px;align-items:center;margin-top:2px}
      button{all:unset;cursor:pointer;font:inherit;font-size:11px;color:#9b938b;
             border-bottom:1px dotted #5a534c}
      button:hover{color:#f6f4f1}
      :is(a,button):focus-visible{outline:2px solid #8fc7ff;outline-offset:2px}
      .x{position:absolute;top:4px;inset-inline-end:6px;font-size:14px;color:#6f6862;
         border:0;line-height:1}
      .wrap{position:relative}
      .fr{font-size:10px;color:#9b938b;max-width:230px;line-height:1.35;margin-top:4px;
          border-top:1px solid #2a2622;padding-top:5px}
      @media (prefers-reduced-motion:no-preference){.b{transition:none}}
    </style><div class="wrap"><div class="b" role="complementary" aria-label="AliExpress price comparison">
      <button class="x" title="Dismiss" aria-label="Dismiss">×</button>
      <div class="row"><span class="mk pending" data-mk>·····</span></div>
      <div class="ali" data-ali></div>
      <div class="sub" data-sub></div>
      <div class="acts"><a data-link target="_blank" rel="noopener noreferrer">on AliExpress</a>
        <button data-copy hidden>copy receipt</button>
        <button data-mute>mute this store</button></div>
    </div></div>`;
    (document.body || document.documentElement).appendChild(host);
    root.querySelector('.x').onclick = teardown;
    root.querySelector('[data-mute]').onclick = async () => {
      await ask({ type: 'mute', host: HOST });
      teardown();
    };
    badge = host;
    return root;
  }

  async function render(gen, extraction, verdict) {
    if (gen !== generation) return log('stale verdict discarded');
    if (!verdict || verdict.render === 'none') return log('silent:', verdict && verdict.reasons);

    const root = badge ? badge.shadowRoot : mount();
    const $ = (s) => root.querySelector(s);
    $('[data-link]').href = verdict.aliUrl || verdict.searchUrl || '#';

    if (verdict.render === 'link-only') {
      $('[data-mk]').textContent = '·····';
      $('[data-mk]').classList.add('pending');
      $('[data-ali]').textContent = 'found on AliExpress';
      $('[data-sub]').textContent = 'no confident price match';
      log('link-only:', verdict.reasons);
    } else {
      $('[data-mk]').textContent = '+' + verdict.markup + '%';
      $('[data-mk]').classList.remove('pending');
      const cur = verdict.aliCurrency === 'USD' ? '$' : '';
      $('[data-ali]').textContent = `${cur}${verdict.aliPrice} on AliExpress`;
      $('[data-sub]').textContent =
        `excludes shipping · ${verdict.shipTo}/${verdict.aliCurrency} · ${verdict.capturedAt}`;
      $('[data-copy]').hidden = false;
      $('[data-copy]').onclick = () => copyReceipt(extraction, verdict, $);
    }

    const fr = await ask({ type: 'firstRunSeen' });
    if (fr && fr.first) {
      const d = document.createElement('div');
      d.className = 'fr';
      d.textContent =
        'AliBadge found this product on AliExpress. It only appears when the match is confident.';
      $('.b').appendChild(d);
    }
  }

  // ponytail: text receipt, not the designed PNG. The approved mockup needs a
  // canvas composition; this proves the data is all present and copyable first.
  async function copyReceipt(extraction, v, $) {
    const lines = [
      `${extraction.host} — ${extraction.title}`,
      `store:      ${extraction.price} ${extraction.currency || ''}`.trim(),
      `aliexpress: ${v.aliPrice} ${v.aliCurrency}`,
      `markup:     +${v.markup}%`,
      v.sold ? `sold:       ${v.sold}` : null,
      `ships-to ${v.shipTo} · ${v.aliCurrency} · captured ${v.capturedAt} · excludes shipping`,
      v.aliUrl || '',
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      $('[data-copy]').textContent = 'copied';
      setTimeout(() => ($('[data-copy]').textContent = 'copy receipt'), 2000);
    } catch {
      $('[data-copy]').textContent = 'copy failed';
    }
  }

  // --- run -------------------------------------------------------------------

  async function run() {
    const gen = ++generation;
    teardown(); // synchronous, before the new lookup starts

    if (document.visibilityState === 'hidden') {
      log('deferred: tab hidden');
      return;
    }
    const m = await ask({ type: 'isMuted', host: HOST });
    if (m && m.muted) return log('muted:', HOST);

    const extraction = await extract();
    if (gen !== generation) return;
    if (extraction.skip) return log('skip:', extraction.skip, extraction.detail || '');

    const verdict = await ask({ type: 'lookup', extraction });
    await render(gen, extraction, verdict);
  }

  let t = null;
  const schedule = () => { clearTimeout(t); t = setTimeout(run, 400); };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.target === 'content' && msg.type === 'navigated') schedule();
  });

  // Backstop for quick-view / drawer PDPs that change no URL at all, and for
  // variant switches the worker's tabs.onUpdated may not surface.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; schedule(); }
  }, 700);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !badge) schedule();
  });

  schedule();
})();
