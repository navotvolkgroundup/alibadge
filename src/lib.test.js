// bun test
// Covers every path that can produce a WRONG NUMBER — which is the whole reason
// this file exists. Run: bun test
import { expect, test } from 'bun:test';
import {
  parsePrice, parseShopifyCents, isAllowedImageUrl, absoluteFloor, brandGuard,
  decide, pickWinner, urlCacheKey, markupPercent, md5,
  MIN_RATIO, MAX_RATIO, MAX_RATIO_APPLIES_ABOVE,
  vendorMismatch, knownBrandIn, dearestFromSkuMap,
  hamming, stripAlicdnSize, buildGate, HASH_MAX_DISTANCE, importerSignature,
  liveWithin, HOUR_MS,
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

test('knownBrandIn finds the mark the store itself names', () => {
  expect(knownBrandIn('Stanley Quencher 40oz', '')).toBe('stanley');
  expect(knownBrandIn('Tumbler', 'shop.yeti.com')).toBe('yeti');
  expect(knownBrandIn('Vintage Cutlery Set', 'warmlydecor.com')).toBe(null);
  // The token that started this: absent from the list, it produced no caveat at all
  // on a page whose only brand signal is the title.
  expect(knownBrandIn('כיסוי Otterbox ל iPad Air 11', 'i-cell.co.il')).toBe('otterbox');
});

// --- decide() ----------------------------------------------------------------

// warmlydecor carries real DSers plumbing, so the fixture carries it too: a NUMBER now
// requires independent evidence of who copied whom. See importerSignature().
const store = { price: 84.95, currency: 'USD', title: 'Royal Vintage Cutlery Set',
  host: 'warmlydecor.com', importer: ['dsers_sku', 'dsers_image'] };
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

test('the i-cell case: caveat still travels, but a NUMBER now needs evidence', () => {
  // This test used to assert `full`, and that assertion was the false accusation itself:
  // i-cell.co.il is a 15-branch chain selling a LICENSED Otterbox. It has no importer
  // plumbing, so it gets the link and the caveat, and not the number.
  //
  // The earlier decision stands unchanged — a brand mismatch is a printed caveat, not
  // silence. What changed is that the caveat is no longer the ONLY thing standing
  // between a legitimate retailer and a published percentage.
  const v = decide(
    { price: 299, currency: 'ILS', host: 'i-cell.co.il', vendor: 'Otterbox',
      title: 'כיסוי Otterbox ל iPad Air 11"' },
    [{ price: '₪44.60', currency: 'ILS', title: 'Shockproof Folio Case for iPad Air 11',
       url: 'https://x', image: 'https://y' }],
    null,
  );
  expect(v.render).toBe('link-only');
  expect(v.reasons).toContain('no_importer_signature');
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

test('a real markup is no longer suppressed by junk in the result tail', () => {
  // The measured failure that deleted price_dispersion: image search returns unrelated
  // cheap items among the candidates, and judging price SPREAD on them suppressed 5 of
  // 5 genuine dropship markups. The junk must not affect the verdict at all.
  const top = { productId: '1', price: '$7.00', currency: 'USD', title: 'Cutlery Set 24pc' };
  const near = [2, 3, 4].map((i) => ({ ...top, productId: String(i), price: '$8.00' }));
  const junk = [5, 6].map((i) => ({ ...top, productId: String(i), price: '$0.06' }));
  const d = decide({ price: 84.95, currency: 'USD', host: 'warmlydecor.com', vendor: 'Warmly',
    title: 'Cutlery', importer: ['dsers_sku'] }, [top, ...near, ...junk], null);
  expect(d.reasons).toEqual([]);
  expect(d.render).toBe('full');
});

// --- perceptual hash gate ----------------------------------------------------

test('hamming counts differing bits and refuses mismatched inputs', () => {
  expect(hamming('0000', '0000')).toBe(0);
  expect(hamming('0000', '1010')).toBe(2);
  expect(hamming('0000', '000')).toBe(null);
  expect(hamming('0000', null)).toBe(null);
});

test('stripAlicdnSize returns the original image, not a padded thumbnail', () => {
  // Hashing a 220px padded thumbnail against a full-size store photo inflates the
  // distance for images that are byte-identical in origin.
  expect(stripAlicdnSize('https://ae01.alicdn.com/kf/Hab12.jpg_220x220q75.jpg_.webp'))
    .toBe('https://ae01.alicdn.com/kf/Hab12.jpg');
  expect(stripAlicdnSize('https://ae01.alicdn.com/kf/Hab12.jpg'))
    .toBe('https://ae01.alicdn.com/kf/Hab12.jpg');
  expect(stripAlicdnSize(null)).toBe(null);
});

test('buildGate passes only close matches, and never an unhashable one', () => {
  const store = '1'.repeat(64);
  const near = '1'.repeat(60) + '0000';        // distance 4
  const far = '0'.repeat(64);                  // distance 64
  const g = buildGate(store, [
    { item: { productId: 'near' }, hash: near },
    { item: { productId: 'far' }, hash: far },
    { item: { productId: 'unhashed' }, hash: null },
  ]);
  expect(g.map((x) => x.passes)).toEqual([true, false, false]);
  expect(g[0].distance).toBe(4);
  // A missing hash must never pass: absence of evidence is not a match.
  expect(g[2].distance).toBe(Infinity);
});

test('decide goes link-only when the gate rejects every candidate', () => {
  // The Spigen case: a real brand whose photo matches nothing on AliExpress. Ungated
  // this rendered a full badge at 13x against a $2.29 generic band.
  const results = [{ productId: '1', price: '$2.29', currency: 'USD', title: 'Metal Watch Strap 20mm' }];
  const gate = buildGate('1'.repeat(64), [{ item: results[0], hash: '0'.repeat(64) }]);
  const d = decide({ price: 29.99, currency: 'USD', host: 'www.spigen.com', vendor: 'Spigen',
    title: 'Galaxy Watch 9 Thin Fit 360' }, results, gate);
  expect(d.render).toBe('link-only');
  expect(d.reasons).toContain('no_passing_match');
});

test('decide still badges when the gate confirms the same photograph', () => {
  // warmlydecor matte-black: measured distance 0, pixel-identical supplier photo.
  const results = [{ productId: '1', price: '$18.21', currency: 'USD', title: 'Cutlery Set 24pcs' }];
  const same = '1'.repeat(64);
  const d = decide({ price: 70.95, currency: 'USD', host: 'warmlydecor.com', vendor: 'Warmly',
    title: 'Matte Black Cutlery Set', importer: ['dsers_sku'] }, results,
    buildGate(same, [{ item: results[0], hash: same }]));
  expect(d.render).toBe('full');
  expect(d.reasons).toEqual([]);
});

test('an absent gate must reject, never fall back to rank', () => {
  // MEASURED failure: i-cell.co.il rendered +570% against a licensed Otterbox whose
  // closest gallery image is 21 bits away. The gate was right and simply absent —
  // gateFromStored returned null when no candidate carried a distance, and decide()
  // fell back to AliExpress's rank. An empty gate array must mean nothing passes.
  const results = [{ productId: '1', price: '$44.60', currency: 'ILS', title: 'Magnetic Folio Case' }];
  const emptyGate = results.map((item) => ({ item, distance: Infinity, passes: false }));
  const d = decide({ price: 299, currency: 'ILS', host: 'www.i-cell.co.il', vendor: 'iCell',
    title: 'כיסוי Otterbox ל iPad Air 11' }, results, emptyGate);
  expect(d.render).toBe('link-only');
  expect(d.reasons).toContain('no_passing_match');
});

// --- importer signature ------------------------------------------------------

test('importerSignature spots DSers plumbing, from real warmlydecor data', () => {
  expect(importerSignature({
    variants: [{ sku: '35030427-china-1-sets-4pcs' }],
    images: ['//cdn.shopify.com/s/files/1/0/products/product-image-1410527736.jpg?v=1601416180'],
    vendor: 'Warmly',
  })).toEqual(['dsers_sku', 'dsers_image']);
});

test('importerSignature finds nothing on a real brand, from real Misen data', () => {
  // The measured near-miss: Misen passed the hash gate at 5-10 bits. No importer
  // signature is what must keep it link-only.
  expect(importerSignature({
    variants: [{ sku: 'MSN-CS-8' }],
    images: ['//cdn.shopify.com/s/files/1/0/files/Misen2-Web-PDP-GlassLid-PSCS-8_-Gallery-1.jpg'],
    vendor: 'Misen',
  })).toEqual([]);
  expect(importerSignature({})).toEqual([]);
});

test('a number requires an importer signature; a link does not', () => {
  const results = [{ productId: '1', price: '$18.24', currency: 'USD', title: 'Gold Cutlery Set' }];
  const same = '1'.repeat(64);
  const gate = buildGate(same, [{ item: results[0], hash: same }]);
  const store = { price: 73.95, currency: 'USD', host: 'x.com', vendor: 'X', title: 'Cutlery Set' };

  // Photo match, real markup, but no evidence of who copied whom -> no number.
  const without = decide(store, results, gate);
  expect(without.render).toBe('link-only');
  expect(without.reasons).toContain('no_importer_signature');

  // Same everything, plus DSers plumbing -> the number is defensible.
  const withSig = decide({ ...store, importer: ['dsers_sku'] }, results, gate);
  expect(withSig.render).toBe('full');
  expect(withSig.reasons).toEqual([]);
});

// --- rate-limit window -------------------------------------------------------

test('liveWithin keeps everything inside the window', () => {
  // THE BUG: the old prune deleted the first live stamp every call, so with steady
  // traffic the array never grew past length 1 and HOURLY_CAP never fired once.
  const now = 1_000_000;
  const stamps = [now - 10, now - 20, now - 30];
  expect(liveWithin(stamps, now)).toEqual(stamps);
});

test('liveWithin drops only what has aged out', () => {
  const now = 10 * HOUR_MS;
  const stale = now - HOUR_MS - 1;
  const fresh = now - 5;
  expect(liveWithin([stale, fresh], now)).toEqual([fresh]);
  expect(liveWithin([stale, stale], now)).toEqual([]);
  // Junk in, empty out, rather than NaN arithmetic silently disabling the cap.
  expect(liveWithin([NaN, undefined, fresh], now)).toEqual([fresh]);
  expect(liveWithin(null, now)).toEqual([]);
});

test('the hourly cap actually engages — the symptom, not just the helper', () => {
  // Replay enqueue's bookkeeping over 200 calls 4s apart, all inside the hour.
  const CAP = 120;
  let now = 1_000_000, capped = 0;
  let stamps = [];
  for (let i = 0; i < 200; i++) {
    now += 4000;
    const live = liveWithin(stamps, now);
    if (live.length >= CAP) { capped++; continue; }
    stamps = [...live, now];
  }
  expect(stamps.length).toBe(CAP);
  expect(capped).toBe(200 - CAP);
});

test('worker.js actually USES liveWithin — the helper existing is not the fix', () => {
  // I shipped a commit titled "fix the hourly rate cap" that did not fix it: the edit
  // targeted a pattern that only existed on a branch, so it silently matched nothing.
  // liveWithin() and its tests landed, the caller kept the broken splice, and every
  // test still passed. A pure helper proves nothing about the code path that calls it.
  const src = require('node:fs').readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  expect(src).toContain('liveWithin(hourStamps, now)');
  expect(src).not.toContain('hourStamps.splice(');
});
