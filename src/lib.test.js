// bun test
// Covers every path that can produce a WRONG NUMBER — which is the whole reason
// this file exists. Run: bun test
import { expect, test } from 'bun:test';
import {
  parsePrice, parseShopifyCents, isAllowedImageUrl, absoluteFloor, brandGuard,
  decide, pickWinner, urlCacheKey, markupPercent, md5,
  MIN_RATIO, MAX_RATIO, MAX_RATIO_APPLIES_ABOVE,
  vendorMismatch, knownBrandIn, dearestFromSkuMap,
} from './lib.js';

// --- price parsing -----------------------------------------------------------

test('parsePrice handles the real formats seen in the API', () => {
  expect(parsePrice('₪ 21.44')).toBe(21.44);
  expect(parsePrice('$9.72')).toBe(9.72);
  expect(parsePrice('US $12.53')).toBe(12.53);
  expect(parsePrice('₪1,234.50')).toBe(1234.5);
  expect(parsePrice(21.44)).toBe(21.44);
});

test('parsePrice takes the MAX of a range, never the min', () => {
  // Measured: one listing spanned $5.14-$89.83. Taking the low end inflates markup
  // and flipped 3 of 10 verdicts in testing.
  expect(parsePrice('$4.99 - $12.99')).toBe(12.99);
  expect(parsePrice('₪ 9.72 – ₪ 89.83')).toBe(89.83);
});

test('parsePrice rejects junk rather than guessing', () => {
  for (const v of ['', 'Free', null, undefined, {}, [], 0, -5, 'US $0.00']) {
    expect(parsePrice(v)).toBe(null);
  }
});

test('parseShopifyCents never reads cents as dollars', () => {
  expect(parseShopifyCents('8495')).toBe(84.95);
  expect(parseShopifyCents(1290)).toBe(12.9);
  expect(parseShopifyCents('0')).toBe(null);
  expect(parseShopifyCents(null)).toBe(null);
});

// --- SSRF allowlist ----------------------------------------------------------

const ORIGIN = 'https://warmlydecor.com';

test('allowlist accepts the page origin and known CDNs', () => {
  expect(isAllowedImageUrl('https://cdn.shopify.com/s/files/1/x/product-image-1.jpg', ORIGIN)).toBe(true);
  expect(isAllowedImageUrl('https://warmlydecor.com/img/a.jpg', ORIGIN)).toBe(true);
  expect(isAllowedImageUrl('https://ae01.alicdn.com/kf/H123.jpg', ORIGIN)).toBe(true);
});

test('allowlist blocks the SSRF targets that motivated it', () => {
  const bad = [
    'http://cdn.shopify.com/x.jpg',            // not https
    'https://localhost/x.jpg',
    'https://127.0.0.1/x.jpg',
    'https://10.0.0.5/x.jpg',
    'https://192.168.1.1/x.jpg',
    'https://172.16.0.1/x.jpg',
    'https://169.254.169.254/latest/meta-data/', // cloud metadata
    'https://[::1]/x.jpg',
    'https://intranet.local/x.jpg',
    'https://cdn.shopify.com:8080/x.jpg',        // odd port
    'https://evil.example.com/x.jpg',            // unrelated host
  ];
  for (const u of bad) expect(isAllowedImageUrl(u, ORIGIN)).toBe(false);
});

test('allowlist is not fooled by suffix lookalikes', () => {
  expect(isAllowedImageUrl('https://cdn.shopify.com.evil.net/x.jpg', ORIGIN)).toBe(false);
  // Sibling host, NOT a subdomain of cdn.shopify.com — must be rejected.
  expect(isAllowedImageUrl('https://notcdn.shopify.com/x.jpg', ORIGIN)).toBe(false);
  // Genuine subdomain of an allowed CDN — accepted.
  expect(isAllowedImageUrl('https://foo.cdn.shopify.com/x.jpg', ORIGIN)).toBe(true);
});

test('allowlist rejects non-http schemes', () => {
  for (const u of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'blob:xyz']) {
    expect(isAllowedImageUrl(u, ORIGIN)).toBe(false);
  }
});

test('a bare relative path resolves to the page origin and is allowed', () => {
  // Shopify JSON legitimately carries relative and protocol-relative image paths.
  expect(isAllowedImageUrl('/files/a.jpg', ORIGIN)).toBe(true);
  expect(isAllowedImageUrl('//cdn.shopify.com/s/a.jpg', ORIGIN)).toBe(true);
});

// --- floors ------------------------------------------------------------------

test('absoluteFloor is a static per-currency table with a default', () => {
  expect(absoluteFloor('USD')).toBe(15);
  expect(absoluteFloor('ils')).toBe(55);
  expect(absoluteFloor('XYZ')).toBe(15);
  expect(absoluteFloor(undefined)).toBe(15);
});

// --- brand guard -------------------------------------------------------------

test('brand guard ignores a huge ratio on CHEAP goods (the calibration fix)', () => {
  // Measured real dropshipper: $84.95 store vs $2.37 AliExpress = ~36x. That is
  // ordinary dropshipping on a cheap item, NOT a counterfeit. Must not veto.
  expect(brandGuard({ storePrice: 84.95, aliPrice: 2.37, title: 'Royal Vintage Cutlery Set' })).toEqual([]);
});

test('brand guard vetoes a huge ratio on an EXPENSIVE marketplace item', () => {
  // $200 item at 36x suggests a counterfeit of a premium brand.
  const r = brandGuard({ storePrice: 7200, aliPrice: 200, title: 'Insulated Tumbler' });
  expect(r).toContain('ratio_implausible');
});

test('brand guard vetoes known brand tokens in title or host', () => {
  expect(knownBrandIn('Stanley Quencher 40oz', '')).toBe('stanley');
  expect(knownBrandIn('Tumbler', 'shop.yeti.com')).toBe('yeti');
  expect(knownBrandIn('Vintage Cutlery Set', 'warmlydecor.com')).toBe(null);
  // The token that started this: absent from the list, it produced no caveat at all
  // on a page whose only brand signal is the title.
  expect(knownBrandIn('כיסוי Otterbox ל iPad Air 11', 'i-cell.co.il')).toBe('otterbox');
});

test('brand guard vetoes extreme price dispersion', () => {
  const r = brandGuard({ storePrice: 90, aliPrice: 5, title: 'x', resultPrices: [2, 4, 9, 60, 120] });
  expect(r).toContain('price_dispersion');
});

// --- decide() ----------------------------------------------------------------

const store = { price: 84.95, currency: 'USD', title: 'Royal Vintage Cutlery Set', host: 'warmlydecor.com' };
const results = [
  { productId: '1', price: '$9.72', currency: 'USD' },
  { productId: '2', price: '$35.97', currency: 'USD' },
];

test('decide renders full on a clean dropship match', () => {
  const d = decide(store, results, null);
  expect(d.render).toBe('full');
  expect(d.winner.productId).toBe('1');
  expect(d.reasons).toEqual([]);
});

test('decide returns ALL failing reasons, not just the first', () => {
  // $20 store vs $19 ali: fails ratio AND absolute floor together.
  const d = decide({ ...store, price: 20 }, [{ productId: '1', price: '$19', currency: 'USD' }], null);
  expect(d.reasons).toContain('below_ratio_floor');
  expect(d.reasons).toContain('below_absolute_floor');
  expect(d.reasons.length).toBeGreaterThan(1);
});

test('decide degrades to link-only, never silence, when a fileId exists but the number does not', () => {
  expect(decide(store, [], null).render).toBe('link-only');
  expect(decide(store, [{ productId: '1', price: 'Free' }], null).render).toBe('link-only');
  expect(decide({ ...store, price: 30 }, [{ productId: '1', price: '$25', currency: 'USD' }], null).render).toBe('link-only');
});

test('a brand name renders full and carries the caveat, it does not silence', () => {
  // Twice measured: suppressing here discarded a genuinely cheaper listing for the
  // same item. The caveat prevents the implication that silence was protecting.
  const d = decide({ ...store, title: 'Stanley Quencher' }, results, null);
  expect(d.render).toBe('full');
  expect(d.note).toBe('stanley is a brand name — listing may be a copy');
});

test('no brand caveat when the listing itself claims the brand', () => {
  const d = decide(
    { ...store, title: 'Stanley Quencher' },
    [{ productId: '1', price: '$9.72', currency: 'USD', title: 'Stanley Quencher 40oz Tumbler' }],
    null,
  );
  expect(d.render).toBe('full');
  expect(d.note).toBe(null);
});

test('decide still goes SILENT on a real guard trip, not link-only', () => {
  // Linking would still imply something about a match we think is wrong.
  // $400 against a $20 listing: 20x, and the $20 clears MAX_RATIO_APPLIES_ABOVE, so
  // this is the implausible-gap case and not a cheap-goods false alarm.
  const d = decide(
    { ...store, price: 400 },
    [{ productId: '1', price: '$20', currency: 'USD', title: 'Tumbler' }],
    null,
  );
  expect(d.render).toBe('none');
  expect(d.reasons).toContain('ratio_implausible');
});

test('decide bails on currency mismatch rather than comparing across currencies', () => {
  const d = decide(store, [{ productId: '1', price: '₪ 21.44', currency: 'ILS' }], null);
  expect(d.render).toBe('link-only');
  expect(d.reasons).toContain('currency_mismatch');
});

test('decide refuses to render without a store price', () => {
  expect(decide({ price: 0 }, results, null).render).toBe('none');
  expect(decide(null, results, null).reasons).toContain('no_store_price');
});

// --- winner selection --------------------------------------------------------

test('pickWinner takes lowest distance, and the HIGHER price on a tie', () => {
  const gate = [
    { item: { productId: 'a', price: '$5' }, distance: 10, passes: true },
    { item: { productId: 'b', price: '$40' }, distance: 4, passes: true },
    { item: { productId: 'c', price: '$60' }, distance: 4, passes: true },
    { item: { productId: 'd', price: '$1' }, distance: 1, passes: false },
  ];
  // c and b tie at distance 4; c is dearer, so c wins (conservative direction).
  expect(pickWinner([], gate).productId).toBe('c');
});

test('pickWinner falls back to marketplace rank with no gate', () => {
  expect(pickWinner(results, null).productId).toBe('1');
  expect(pickWinner([], [{ item: {}, distance: 1, passes: false }])).toBe(null);
});

// --- cache keys --------------------------------------------------------------

test('urlCacheKey keeps ?variant and strips cache-busters', () => {
  const a = urlCacheKey('https://s.com/products/x?variant=42&utm_source=tiktok');
  const b = urlCacheKey('https://s.com/products/x/?variant=42&v=999');
  expect(a).toBe('https://s.com/products/x?variant=42');
  expect(a).toBe(b);
  expect(urlCacheKey('https://s.com/products/x?variant=43')).not.toBe(a);
  expect(urlCacheKey('nope')).toBe(null);
});

test('markupPercent matches the measured figure', () => {
  expect(markupPercent(84.95, 9.72)).toBe(774);
});

// --- md5 (MTOP signing) ------------------------------------------------------

test('md5 matches known vectors', () => {
  expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  expect(md5('a'.repeat(64))).toBe('014842d480b571495a4a0363793f7367');
});

test('md5 handles non-ascii (signing payloads carry Hebrew/Chinese titles)', () => {
  // Vectors verified against the `md5` CLI, not assumed.
  expect(md5('日本語')).toBe('00110af8b4393ef3f72c50be5b332bec');
});

test('md5 handles the separators the MTOP sign string is built from', () => {
  // sign = md5(token + "&" + t + "&" + appKey + "&" + data)
  expect(md5('a b&c')).toBe('8e193f79dcba7d1b300ede08603f81d3');
});

// The measured false accusation: a real Otterbox case on a legitimate 15-branch
// Israeli retailer, matched against a generic AliExpress case at 6.7x.
test('vendorMismatch flags a declared vendor the listing never names', () => {
  const args = {
    storePrice: 299, aliPrice: 44.6, storeHost: 'i-cell.co.il',
    title: 'כיסוי Otterbox ל iPad Air 11"',
    aliTitle: 'Shockproof Folio Case for iPad Air 11 inch Tablet Cover',
  };
  expect(vendorMismatch('Otterbox', args.storeHost, args.aliTitle)).toBe(true);
  // Same listing, but the marketplace item IS an Otterbox: nothing to say.
  expect(vendorMismatch('Otterbox', args.storeHost,
    'Original OtterBox Symmetry Folio for iPad Air 11')).toBe(false);
});

test('vendorMismatch ignores a shop name whose punctuation differs from its host', () => {
  // Measured on i-cell.co.il: vendor is "iCell", and both ld+json brand entries say
  // iCell too. A raw substring test misses this in both directions and emits the
  // useless caveat "listing does not name iCell".
  expect(vendorMismatch('iCell', 'www.i-cell.co.il',
    'Shockproof Folio Case for iPad Air 11')).toBe(false);
});

test('vendorMismatch ignores a vendor that is just the shop name', () => {
  // Dropshippers set vendor to themselves; flagging that would put a meaningless
  // caveat on exactly the stores this exists to find.
  expect(vendorMismatch('WarmlyDecor', 'www.warmlydecor.com',
    'Luxury Gold Stainless Steel Cutlery Set 24pc')).toBe(false);
});

test('a branded mismatch still renders full, carrying the caveat', () => {
  // The measured i-cell case: suppressing it threw away a true find.
  const v = decide(
    { price: 299, currency: 'ILS', host: 'i-cell.co.il', vendor: 'Otterbox',
      title: 'כיסוי Otterbox ל iPad Air 11"' },
    [{ price: '₪44.60', currency: 'ILS', title: 'Shockproof Folio Case for iPad Air 11',
       url: 'https://x', image: 'https://y' }],
    null,
  );
  expect(v.render).toBe('full');
  expect(v.note).toBe('listing does not name Otterbox');
});

// Entry copied verbatim from a live pdp.pc.query payload for 32930388619.
const SKU_ENTRY = {
  discount: '5% off',
  originalPrice: { currency: 'USD', formatedAmount: '$10.32', value: 10.32 },
  priceFontColor: '#000000',
  salePriceLocal: '$9.80|9|80',
  salePriceString: '$9.80',
  sellerByLot: false,
};

test('dearestFromSkuMap takes the DEAREST sale price across variants', () => {
  const map = {
    a: { ...SKU_ENTRY, salePriceString: '$6.28', salePriceLocal: '$6.28|6|28' },
    b: { ...SKU_ENTRY, salePriceString: '$7.62', salePriceLocal: '$7.62|7|62' },
    c: SKU_ENTRY, // $9.80, the measured maximum of the real 24-sku listing
  };
  expect(dearestFromSkuMap(map, 'USD')).toBe(9.8);
});

test('dearestFromSkuMap never reads salePriceLocal, which would 10x the number', () => {
  // "$9.80|9|80" -> parsePrice takes the max token -> 80. Asserted so nobody "tidies"
  // the parser onto that field: it fails silently and in the accusing direction.
  expect(parsePrice(SKU_ENTRY.salePriceLocal)).toBe(80);
  expect(dearestFromSkuMap({ c: SKU_ENTRY }, 'USD')).toBe(9.8);
});

test('dearestFromSkuMap ignores originalPrice, the struck-through figure', () => {
  // originalPrice 10.32 is higher than the sale price and would inflate markup.
  expect(dearestFromSkuMap({ c: SKU_ENTRY }, 'USD')).not.toBe(10.32);
});

test('dearestFromSkuMap refuses a currency the caller did not ask for', () => {
  const ils = { c: { ...SKU_ENTRY, originalPrice: { currency: 'ILS', value: 38 } } };
  expect(dearestFromSkuMap(ils, 'USD')).toBe(null);
  // No expectation passed means no cross-currency claim to check.
  expect(dearestFromSkuMap(ils)).toBe(9.8);
});

test('dearestFromSkuMap returns null on junk rather than a wrong number', () => {
  expect(dearestFromSkuMap(null, 'USD')).toBe(null);
  expect(dearestFromSkuMap({}, 'USD')).toBe(null);
  expect(dearestFromSkuMap({ a: { salePriceString: 'Free' } }, 'USD')).toBe(null);
});
