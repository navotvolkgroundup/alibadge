// Content script. Self-contained on purpose: content scripts cannot use ES imports,
// and keeping the pure logic in the worker means it is never duplicated here.
// This file only extracts, renders, and tears down.
(() => {
  const PRODUCT_PATH = /^\/products\/[^/]+\/?$/;
  const HOST = location.hostname;

  let generation = 0;
  let badge = null;
  let debug = true; // see worker.js — on by default for unpacked builds
  chrome.storage.local.get('alibadgeDebug').then((r) => (debug = r.alibadgeDebug !== false));
  const log = (...a) => debug && console.log('[alibadge]', ...a);
  // Unconditional: absence of this line in the PAGE console proves the content
  // script never injected, which is a completely different problem from a skip.
  console.log('[alibadge] content script alive on', location.host + location.pathname);

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

  // Read the structured data the page already publishes rather than guessing at
  // theme CSS. Loose selectors like `.price` match recommendation cards elsewhere
  // on the page — measured: they returned 78.95 (a different product) on a page
  // whose actual price is 259.
  //
  // The ratio is currency-invariant, so all that matters is that the store price
  // and the marketplace price use the SAME currency. JSON-LD gives an authoritative
  // price AND its currency together, which is exactly the pair needed.
  function structuredPrice() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(s.textContent); } catch { continue; }
      for (const node of flatten(data)) {
        if (!node || typeof node !== 'object') continue;
        const type = node['@type'];
        const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
        if (!isProduct || !node.offers) continue;
        for (const offer of [].concat(node.offers)) {
          if (!offer || typeof offer !== 'object') continue;
          const raw = offer.price ?? offer.lowPrice ?? offer.highPrice;
          const price = parseFloat(String(raw).replace(/,/g, ''));
          if (Number.isFinite(price) && price > 0) {
            return { price, currency: offer.priceCurrency || null, src: 'ld+json' };
          }
        }
      }
    }
    // Both spellings occur in the wild. Measured on warmlydecor: it publishes
    // og:price:* and no ld+json at all.
    for (const pfx of ['og:price', 'product:price']) {
      const amt = document.querySelector(`meta[property="${pfx}:amount"]`);
      const cur = document.querySelector(`meta[property="${pfx}:currency"]`);
      const price = amt && parseFloat(String(amt.getAttribute('content')).replace(/,/g, ''));
      if (Number.isFinite(price) && price > 0) {
        return { price, currency: cur ? cur.getAttribute('content') : null, src: pfx };
      }
    }
    return null;
  }

  // Last resort for currency only. /cart.js is a stable same-origin Shopify
  // endpoint that always reports the shop's active currency.
  async function cartCurrency() {
    try {
      const r = await fetch('/cart.js', { credentials: 'same-origin' });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.currency ? j.currency : null;
    } catch {
      return null;
    }
  }

  function* flatten(v, depth = 0) {
    if (!v || typeof v !== 'object' || depth > 5) return;
    if (Array.isArray(v)) { for (const x of v) yield* flatten(x, depth + 1); return; }
    yield v;
    if (v['@graph']) yield* flatten(v['@graph'], depth + 1);
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

    let finalPrice = price;
    let finalCurrency = currency;

    const sp = structuredPrice();
    if (sp && sp.currency) {
      // Authoritative: an explicit price paired with its own currency code.
      finalPrice = sp.price;
      finalCurrency = sp.currency;
      if (Math.abs(sp.price - price) > Math.max(0.02, price * 0.02)) {
        log(`price from ${sp.src}: ${sp.price} ${sp.currency} (products.json had ${price})`);
      }
    } else if (!finalCurrency) {
      finalCurrency = await cartCurrency();
      // A bare number with no currency cannot be compared against anything safely.
      if (!finalCurrency) return { skip: 'no_currency', detail: { jsonPrice: price, structured: sp } };
      log('currency from /cart.js:', finalCurrency);
    }

    const image = variant.featured_image?.src || p.images?.[0] || p.featured_image || null;
    if (!image) return { skip: 'no_image' };

    return {
      url: location.href,
      host: HOST,
      title: p.title || '',
      price: finalPrice,
      currency: finalCurrency,
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
    // `all:initial` MUST come first: it resets every property, so anything declared
    // before it is wiped. With it last, position/bottom/z-index were all reset to
    // static and the badge silently rendered at the end of <body> instead of
    // pinned — visible only if you scrolled to the very bottom of the page.
    //
    // Not bottom-right: nearly every Shopify store puts a chat widget there.
    // Logical properties so RTL mirrors automatically (Hebrew stores exist).
    host.style.cssText =
      'all:initial;' +
      'position:fixed !important;bottom:20px !important;inset-inline-start:20px !important;' +
      'z-index:2147483000 !important;contain:layout style;';
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
      /* all:unset above resets display too, which clobbers the [hidden]
         attribute's display:none, so "copy receipt" showed in the link-only state
         where there is no number to put on a receipt. Same class of bug as the
         all:initial ordering one. (No backticks in here: this CSS lives inside a
         template literal.) */
      [hidden]{display:none !important}
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
    if (!verdict || verdict.render === 'none') {
      console.log('[alibadge] SILENT —', ((verdict && verdict.reasons) || ['no response']).join(', '));
      return;
    }

    const root = badge ? badge.shadowRoot : mount();
    const $ = (s) => root.querySelector(s);
    $('[data-link]').href = verdict.aliUrl || verdict.searchUrl || '#';

    if (verdict.render === 'link-only') {
      $('[data-mk]').textContent = '·····';
      $('[data-mk]').classList.add('pending');
      $('[data-ali]').textContent = 'found on AliExpress';
      const why = (verdict.reasons || []).join(', ');
      // Put the reason ON the badge in debug builds. Silence-as-default means the
      // console is the only failure signal, and hunting for one line in a merchant
      // page's console is a miserable way to find it.
      $('[data-sub]').textContent = debug && why ? why : 'no confident price match';
      console.log('[alibadge] link-only —', why);
    } else {
      $('[data-mk]').textContent = '+' + verdict.markup + '%';
      $('[data-mk]').classList.remove('pending');
      const cur = verdict.aliCurrency === 'USD' ? '$' : '';
      $('[data-ali]').textContent = `${cur}${verdict.aliPrice} on AliExpress`;
      console.log('[alibadge] FULL — markup +' + verdict.markup + '%');
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

  // The receipt PNG is the artifact that actually travels. Rendered and written to
  // the clipboard HERE, on a user gesture with the document focused: the worker has
  // no navigator.clipboard.
  async function copyReceipt(extraction, v, $) {
    const btn = $('[data-copy]');
    const done = (label, revert = true) => {
      btn.textContent = label;
      if (revert) setTimeout(() => (btn.textContent = 'copy receipt'), 2200);
    };
    btn.textContent = 'rendering…';
    try {
      const blob = await AliBadgeReceipt.render({
        storeHost: extraction.host,
        storeTitle: extraction.title,
        storePrice: extraction.price,
        currency: extraction.currency,
        storeImage: extraction.image,
        aliTitle: v.aliTitle,
        aliPrice: v.aliPrice,
        aliImage: v.aliImage,
        aliUrl: v.aliUrl,
        sold: v.sold,
        markup: v.markup,
        // Printed on the receipt rather than implied. Today the results API gives
        // one price per listing and it is the listing's LOWEST variant, which
        // inflates the ratio — so say so, and change this string when the
        // conservative dearest-variant lookup lands.
        priceBasis: 'matched listing, lowest variant',
        shipTo: v.shipTo,
        capturedAt: v.capturedAt,
      });
      if (!blob) return done('render failed');

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      done('copied ✓');
      log('receipt copied,', Math.round(blob.size / 1024) + 'kb');
    } catch (e) {
      // Most likely causes: the document lost focus, or clipboard-image write is
      // unsupported. Offer the file instead of failing silently.
      log('receipt clipboard failed:', String(e).slice(0, 120));
      try {
        const blob = await AliBadgeReceipt.render(receiptData(extraction, v));
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `alibadge-${extraction.host}-${v.capturedAt}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        done('downloaded ✓');
      } catch {
        done('copy failed');
      }
    }
  }

  function receiptData(extraction, v) {
    return {
      storeHost: extraction.host, storeTitle: extraction.title,
      storePrice: extraction.price, currency: extraction.currency,
      storeImage: extraction.image, aliTitle: v.aliTitle, aliPrice: v.aliPrice,
      aliImage: v.aliImage, aliUrl: v.aliUrl, sold: v.sold, markup: v.markup,
      priceBasis: 'matched listing, lowest variant',
      shipTo: v.shipTo, capturedAt: v.capturedAt,
    };
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
    if (extraction.skip) {
      // Unconditional: a skip is the difference between "working and silent" and
      // "broken and silent", and those must never look the same.
      console.log('[alibadge] SKIP:', extraction.skip, extraction.detail || '');
      return;
    }
    console.log('[alibadge] extracted', extraction.price, extraction.currency, '→ asking worker');

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
