// Pure functions. No chrome.*, no DOM, no network — everything here is unit-testable.
// This is deliberate: every path that can produce a WRONG NUMBER lives in this file.

// ---------------------------------------------------------------------------
// Price parsing
// ---------------------------------------------------------------------------

// AliExpress prices arrive as "₪ 21.44", "$9.72", "US $12.53", and frequently as
// ranges like "$4.99 - $12.99". Ranges take the MAX: the low end is usually a
// 1-piece variant and comparing a 24-piece store set against it inflates markup.
export function parsePrice(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? input : null;
  if (typeof input !== 'string') return null;
  // Token must swallow thousands separators, or "₪1,234.50" parses as [1234, 50]
  // and Math.max picks 1234 — losing the cents and, worse, silently succeeding.
  const nums = input.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!nums) return null;
  const vals = nums
    .map((n) => parseFloat(n.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!vals.length) return null;
  return Math.max(...vals);
}

// Shopify gives price in cents as a string. Keep it separate from parsePrice so a
// "1999" cents value can never be read as $1999.
export function parseShopifyCents(cents) {
  const n = typeof cents === 'string' ? parseInt(cents, 10) : cents;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 100;
}

// ---------------------------------------------------------------------------
// Image URL allowlist (SSRF guard)
// ---------------------------------------------------------------------------

const CDN_SUFFIXES = ['cdn.shopify.com', 'alicdn.com', 'aliexpress-media.com'];
const PRIVATE_HOST =
  /^(localhost|0\.0\.0\.0|\[?::1\]?|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

// The image URL comes from page-controlled content (featured_image / og:image) and
// the worker fetches it with broad host_permissions. Unvalidated, any site could
// point it at localhost or a cloud metadata endpoint.
export function isAllowedImageUrl(raw, pageOrigin) {
  let u;
  try {
    u = new URL(raw, pageOrigin);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.port && u.port !== '443') return false;
  if (PRIVATE_HOST.test(u.hostname)) return false;
  if (/\.(local|internal|localdomain)$/i.test(u.hostname)) return false;
  let pageHost = null;
  try {
    pageHost = new URL(pageOrigin).hostname;
  } catch {}
  if (pageHost && u.hostname === pageHost) return true;
  return CDN_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith('.' + s));
}

// ---------------------------------------------------------------------------
// Dearest variant, from pdp.pc.query's skuPriceInfoMap
// ---------------------------------------------------------------------------

// One AliExpress listing spans many variants — measured on 32930388619: 24 skus from
// $6.28 to $9.80. The search results carry only the CHEAPEST, which inflates markup in
// the direction that accuses a merchant, so the dearest is the conservative reading.
//
// Entry shape, dumped verbatim from a live payload:
//   { discount: "5% off",
//     originalPrice: { currency: "USD", formatedAmount: "$10.32", value: 10.32 },
//     salePriceLocal: "$9.80|9|80",
//     salePriceString: "$9.80",
//     sellerByLot: false }
//
// TWO TRAPS, both live in that object:
//  1. salePriceLocal is "$9.80|9|80" — amount, then integer and fraction parts. Handing
//     it to parsePrice yields 80, a 10x overstatement. Only salePriceString is safe.
//  2. originalPrice is the struck-through "was" figure, same trap as compare_at_price
//     store-side. Sale price only.
export function dearestFromSkuMap(map, expectCurrency) {
  if (!map || typeof map !== 'object') return null;
  const prices = [];
  for (const entry of Object.values(map)) {
    if (!entry || typeof entry !== 'object') continue;
    // A currency the caller did not ask for cannot be compared, and silently mixing
    // them is how a ratio becomes fiction.
    const cur = entry.originalPrice && entry.originalPrice.currency;
    if (expectCurrency && cur && cur !== expectCurrency) return null;
    const p = parsePrice(entry.salePriceString);
    if (Number.isFinite(p) && p > 0) prices.push(p);
  }
  return prices.length ? Math.max(...prices) : null;
}

// ---------------------------------------------------------------------------
// Markup floor + brand guard
// ---------------------------------------------------------------------------

// Static table, not an FX lookup: there is no backend, and stale-by-a-few-percent
// is irrelevant against a 3x ratio gate.
const ABS_FLOOR = { USD: 15, EUR: 14, GBP: 12, ILS: 55, CAD: 20, AUD: 22, JPY: 2200 };
export const DEFAULT_ABS_FLOOR = 15;
export function absoluteFloor(currency) {
  return ABS_FLOOR[String(currency || '').toUpperCase()] ?? DEFAULT_ABS_FLOOR;
}

export const MIN_RATIO = 3;
export const MAX_RATIO = 15;
// The upper bound is CONDITIONAL on absolute price. Measured: a real dropshipper at
// $84.95 vs a $5.65 comparable is ~15x, right on the boundary. Cheap goods produce
// huge ratios legitimately because the base price is $2-6, not because the retailer
// is a counterfeit victim. An unconditioned ceiling suppresses genuine dropshippers.
export const MAX_RATIO_APPLIES_ABOVE = 15;

// ponytail: brand list is a stub. Real coverage needs a shipped token list;
// upgrade path is a bundled JSON of registered marks. It is deliberately NOT
// load-bearing any more — see knownBrandIn().
// Now that a hit only prints a caveat, an incomplete list costs a missing caveat
// rather than a suppressed true find — so erring long is the cheap direction.
const KNOWN_BRAND_TOKENS = [
  'stanley', 'owala', 'dyson', 'nike', 'adidas', 'ray-ban', 'rayban', 'apple',
  'samsung', 'sony', 'bose', 'lego', 'yeti', 'hydroflask', 'lululemon',
  'otterbox', 'spigen', 'anker', 'belkin', 'jbl', 'logitech', 'garmin',
  'fitbit', 'xiaomi', 'huawei', 'lenovo', 'asus', 'razer', 'corsair',
];

// A brand the STORE ITSELF declares. Shopify always publishes product.vendor, and
// ld+json publishes brand.name. This beats KNOWN_BRAND_TOKENS because that list is
// unbounded by construction — measured: a real Otterbox iPad case on a 15-branch
// Israeli retail chain rendered +570% against a generic AliExpress case, because
// the list happened to contain 'apple' but not 'otterbox'. There is no version of
// that list that contains every brand.
//
// If the store says "Otterbox" and the matched listing never says "Otterbox", that
// is worth PRINTING, not suppressing. Suppressing it throws away a true find — the
// same case, far cheaper — and the doc's own worry (never assert two things are the
// same branded product when they may not be) is answered by saying so on the badge.
// So this returns a note, not a guard trip.
export function vendorMismatch(vendor, storeHost, aliTitle) {
  const v = String(vendor || '').trim().toLowerCase();
  if (v.length < 3) return false;
  // Stores routinely publish their OWN name as the vendor, and a caveat reading
  // "listing does not name iCell" is pure noise. Compare on alphanumerics only:
  // measured, i-cell.co.il publishes vendor "iCell", and a raw substring test misses
  // that in both directions because of the hyphen.
  const flat = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const shop = flat(String(storeHost).replace(/^www\./, '').split('.')[0]);
  const vf = flat(v);
  if (shop && vf && (vf.includes(shop) || shop.includes(vf))) return false;
  return !String(aliTitle || '').toLowerCase().includes(v);
}

// Which brand token the STORE side mentions, or null. Like vendorMismatch this is a
// note rather than a guard: an unconditional trip on the word 'apple' silenced a
// legitimate cheaper listing for the same case, and suppressing a true find to avoid
// an implication the caveat already prevents is the wrong trade twice over.
export function knownBrandIn(title, storeHost) {
  const hay = (title + ' ' + storeHost).toLowerCase();
  return KNOWN_BRAND_TOKENS.find((b) => hay.includes(b)) || null;
}

export function brandGuard({ storePrice, aliPrice, title = '', storeHost = '', resultPrices = [] }) {
  const reasons = [];
  const ratio = storePrice / aliPrice;

  // Implausible gap on a non-trivial marketplace price suggests a counterfeit of a
  // real brand, not a dropshipper's markup.
  if (aliPrice > MAX_RATIO_APPLIES_ABOVE && ratio > MAX_RATIO) reasons.push('ratio_implausible');


  // Many wildly different prices for one photograph is the counterfeit signature.
  const p = resultPrices.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (p.length >= 4 && p[p.length - 1] / p[0] > 20) reasons.push('price_dispersion');

  return reasons;
}

// ---------------------------------------------------------------------------
// decide() — the single owner of the render policy
// ---------------------------------------------------------------------------
// Returns ALL failing reasons, not the first: tuning needs to know whether the
// floor or the brand guard did the filtering.
//
// NOTE: the generation check deliberately does NOT live here. decide() runs in the
// worker at T; the render happens in the content script at T+delta, by which point
// the generation may have advanced again. It is re-checked at the render site.
export function decide(extraction, results, gate) {
  const reasons = [];
  if (!extraction || !Number.isFinite(extraction.price) || extraction.price <= 0) {
    return { render: 'none', winner: null, reasons: ['no_store_price'] };
  }
  if (!results || !results.length) {
    return { render: 'link-only', winner: null, reasons: ['no_results'] };
  }

  const winner = pickWinner(results, gate);
  if (!winner) return { render: 'link-only', winner: null, reasons: ['no_passing_match'] };

  const aliPrice = parsePrice(winner.price);
  if (!aliPrice) return { render: 'link-only', winner, reasons: ['ali_price_unparseable'] };

  if (extraction.currency && winner.currency && extraction.currency !== winner.currency) {
    return { render: 'link-only', winner, reasons: ['currency_mismatch'] };
  }

  const ratio = extraction.price / aliPrice;
  if (ratio < MIN_RATIO) reasons.push('below_ratio_floor');
  if (extraction.price - aliPrice < absoluteFloor(extraction.currency)) {
    reasons.push('below_absolute_floor');
  }

  const guard = brandGuard({
    storePrice: extraction.price,
    aliPrice,
    title: extraction.title,
    storeHost: extraction.host,
    resultPrices: results.map((r) => parsePrice(r.price)).filter(Boolean),
  });

  // What survives as a hard guard: a gap so implausible on a non-trivial price, or a
  // price spread so wide, that the match itself is suspect. Say nothing at all rather
  // than linking, which would still imply something.
  if (guard.length) return { render: 'none', winner, reasons: [...reasons, ...guard] };

  // Notes are NOT reasons — reasons downgrade the render, notes ride along with a
  // full badge so the number still shows and the caveat shows with it.
  const brand = knownBrandIn(extraction.title || '', extraction.host || '');
  const notes = [];
  if (vendorMismatch(extraction.vendor, extraction.host, winner.title)) {
    notes.push(`listing does not name ${extraction.vendor}`);
  } else if (brand && !String(winner.title || '').toLowerCase().includes(brand)) {
    // Only when the listing does not claim the brand — if it does, the vendor path
    // above already had nothing to say and repeating the brand adds nothing.
    notes.push(`${brand} is a brand name — listing may be a copy`);
  }
  const note = notes.length ? notes.join(' · ') : null;

  if (reasons.length) return { render: 'link-only', winner, reasons, note };
  return { render: 'full', winner, reasons: [], note };
}

// Lowest Hamming distance wins; on ties the HIGHER price wins. Never "cheapest
// passing result" — that maximises both the markup number and the chance of being
// wrong about it. With no gate supplied, fall back to AliExpress's own rank.
export function pickWinner(results, gate) {
  if (!gate || !gate.length) return results[0] || null;
  const passing = gate.filter((g) => g.passes);
  if (!passing.length) return null;
  passing.sort((a, b) => a.distance - b.distance || parsePrice(b.item.price) - parsePrice(a.item.price));
  return passing[0].item;
}

// ---------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------

// Free pre-check. Keep ?variant (it selects the price); strip tracking and Shopify
// cache-busters or the key never hits twice.
export function urlCacheKey(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const keep = new URLSearchParams();
  const variant = u.searchParams.get('variant');
  if (variant) keep.set('variant', variant);
  const q = keep.toString();
  return u.origin + u.pathname.replace(/\/$/, '') + (q ? '?' + q : '');
}

export function markupPercent(storePrice, aliPrice) {
  return Math.round((storePrice / aliPrice - 1) * 100);
}

// ---------------------------------------------------------------------------
// md5 — required for MTOP request signing. WebCrypto has no MD5.
// ---------------------------------------------------------------------------

export function md5(str) {
  const s = utf8(str);
  const n = s.length;
  const words = [];
  for (let i = 0; i < n; i++) words[i >> 2] = (words[i >> 2] | 0) | (s.charCodeAt(i) << ((i % 4) * 8));
  words[n >> 2] = (words[n >> 2] | 0) | (0x80 << ((n % 4) * 8));
  const len = ((n + 8) >> 6) * 16 + 16;
  const x = new Array(len).fill(0);
  for (let i = 0; i < words.length; i++) x[i] = words[i] | 0;
  x[len - 2] = n * 8;

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < len; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, -680876936);      d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17, 606105819);  b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897);  d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416);  d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063);    b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, x[i + 1], 5, -165796510);  d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691);  d = gg(d, a, b, c, x[i + 10], 9, 38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438);   d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, x[i + 5], 4, -378558);     d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174);  d = hh(d, a, b, c, x[i], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487);  d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);

    a = ii(a, b, c, d, x[i], 6, -198630844);      d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359);  d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070);  d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);

    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  return [a, b, c, d].map(hex).join('');
}

function utf8(s) {
  return unescape(encodeURIComponent(String(s)));
}
function add(x, y) {
  const lsw = (x & 0xffff) + (y & 0xffff);
  return (((x >> 16) + (y >> 16) + (lsw >> 16)) << 16) | (lsw & 0xffff);
}
function rol(n, c) {
  return (n << c) | (n >>> (32 - c));
}
function cmn(q, a, b, x, s, t) {
  return add(rol(add(add(a, q), add(x, t)), s), b);
}
function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
function hex(n) {
  let s = '';
  for (let i = 0; i < 4; i++) s += ((n >> (i * 8 + 4)) & 0x0f).toString(16) + ((n >> (i * 8)) & 0x0f).toString(16);
  return s;
}
