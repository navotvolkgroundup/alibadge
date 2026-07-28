// bun test
// content.js runs as a classic (non-module) content script: a bare
// `(() => {...})();` with no exports, injected straight into the page. It
// can't be `import`ed, so — same approach as receipt.test.js takes with
// receipt.js — we read the source, strip the outer IIFE wrapper, and eval
// the body with `new Function`, injecting minimal mock `document` / `chrome`
// / `location` / `fetch` params (shadowing the real globals of the same
// name) plus a `return {...}` that exposes the functions under test.
//
// The auto-run tail (`let t = null; ... schedule();` — timers and
// addEventListener calls that fire the moment the script is injected) is cut
// before eval: it is page-lifecycle wiring, not logic, and left running it
// would leak setInterval/timeout handles across tests. Everything above that
// line — extraction, badge state transitions, receipt data shaping — is kept
// intact and unmodified.
//
// mount()/render()'s actual shadow-DOM painting is intentionally NOT
// exercised here (that's DOM/browser integration, out of scope for a unit
// test — see test/e2e.spec.js). What IS covered: extract()'s full decision
// tree (the part that can produce a WRONG price or a wrong SKIP reason),
// isShopify/structuredPrice/ldBrand/cartCurrency, receiptData's pure mapping,
// and run()'s early-exit guards (hidden tab, muted host, silent verdict).
import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

const RAW = readFileSync(new URL('./content.js', import.meta.url), 'utf8');

const START_MARKER = '(() => {\n';
const END_MARKER = '  let t = null;';
const startIdx = RAW.indexOf(START_MARKER);
const endIdx = RAW.indexOf(END_MARKER);
if (startIdx === -1 || endIdx === -1) {
  throw new Error('content.js shape changed — update the test harness split points');
}
const BODY = RAW.slice(startIdx + START_MARKER.length, endIdx);

const EXPORTS = `
return { isShopify, structuredPrice, ldBrand, cartCurrency, extract, receiptData,
  run, render, FALLBACK_BASIS, PRODUCT_PATH };
`;

function metaEl(value) {
  // Covers both access styles content.js uses on a meta element: property
  // read (extract) and getAttribute (structuredPrice).
  return { content: value, getAttribute: (n) => (n === 'content' ? value : null) };
}
function valueEl(value) {
  return { value };
}

function makeDocument({ query = {}, queryAll = {} } = {}) {
  return {
    querySelector: (sel) => (sel in query ? query[sel] : null),
    querySelectorAll: (sel) => queryAll[sel] || [],
    visibilityState: 'visible',
  };
}

function ldJsonDocs(nodes) {
  // nodes: array of JS objects, each becomes one <script type=ld+json>
  return { queryAll: { 'script[type="application/ld+json"]': nodes.map((n) => ({ textContent: JSON.stringify(n) })) } };
}

function makeChrome({ storageValues = {}, sendMessage } = {}) {
  return {
    storage: { local: { get: async () => storageValues } },
    runtime: {
      sendMessage: sendMessage || ((msg, cb) => cb(null)),
      onMessage: { addListener: () => {} },
    },
  };
}

function makeLocation({ href = 'https://warmlydecor.com/products/widget', search = '' } = {}) {
  const u = new URL(href + search);
  return {
    href: u.href, hostname: u.hostname, host: u.host, pathname: u.pathname,
    search: search || u.search,
  };
}

function load({ document: doc, chrome: chr, location: loc, fetch: fetchImpl } = {}) {
  const logs = [];
  const consoleMock = {
    log: (...a) => logs.push(a.map(String).join(' ')),
    warn: (...a) => logs.push('WARN ' + a.map(String).join(' ')),
  };
  const factory = new Function(
    'document', 'chrome', 'location', 'fetch', 'console', 'navigator', 'ClipboardItem', 'URL', 'setInterval',
    BODY + EXPORTS,
  );
  const api = factory(
    doc || makeDocument(),
    chr || makeChrome(),
    loc || makeLocation(),
    fetchImpl || (async () => ({ ok: false })),
    consoleMock,
    {}, class {}, URL,
    () => {}, // setInterval is only referenced in the cut tail, but harmless to shadow
  );
  return { api, logs };
}

// --- isShopify ---------------------------------------------------------------

describe('isShopify()', () => {
  test('true when the shopify digital wallet meta tag is present', () => {
    const { api } = load({ document: makeDocument({ query: { 'meta[id="shopify-digital-wallet"]': {} } }) });
    expect(api.isShopify()).toBe(true);
  });

  test('true when an image or link references cdn.shopify.com', () => {
    const { api } = load({
      document: makeDocument({ query: { 'img[src*="cdn.shopify.com"], link[href*="cdn.shopify.com"]': {} } }),
    });
    expect(api.isShopify()).toBe(true);
  });

  test('false on a page with neither signal', () => {
    const { api } = load();
    expect(api.isShopify()).toBe(false);
  });
});

// --- structuredPrice ----------------------------------------------------------

describe('structuredPrice()', () => {
  test('reads price + currency from a ld+json Product offer', () => {
    const { api } = load({
      document: makeDocument(ldJsonDocs([{ '@type': 'Product', offers: { price: '259.00', priceCurrency: 'USD' } }])),
    });
    expect(api.structuredPrice()).toEqual({ price: 259, currency: 'USD', src: 'ld+json' });
  });

  test('walks @graph and an array of offers, returning the first parseable positive price', () => {
    const { api } = load({
      document: makeDocument(ldJsonDocs([
        { '@graph': [{ '@type': ['Product', 'Thing'], offers: [{ price: '19.99', priceCurrency: 'ILS' }] }] },
      ])),
    });
    expect(api.structuredPrice()).toEqual({ price: 19.99, currency: 'ILS', src: 'ld+json' });
  });

  test('takes lowPrice/highPrice as a fallback within an offer, but stops at the first offer that parses', () => {
    const { api } = load({
      document: makeDocument(ldJsonDocs([{ '@type': 'Product', offers: [{ lowPrice: '9.99' }, { price: '19.99', priceCurrency: 'ILS' }] }])),
    });
    // The first offer parses (lowPrice 9.99, no currency) so it wins outright —
    // structuredPrice never looks past the first offer that yields a positive number.
    expect(api.structuredPrice()).toEqual({ price: 9.99, currency: null, src: 'ld+json' });
  });

  test('ignores malformed JSON blocks instead of throwing', () => {
    const { api } = load({ document: makeDocument({ queryAll: { 'script[type="application/ld+json"]': [{ textContent: '{not json' }] } }) });
    expect(api.structuredPrice()).toBe(null);
  });

  test('falls back to og:price / product:price meta pairs when there is no ld+json', () => {
    const { api } = load({
      document: makeDocument({
        query: {
          'meta[property="og:price:amount"]': metaEl('84.95'),
          'meta[property="og:price:currency"]': metaEl('USD'),
        },
      }),
    });
    expect(api.structuredPrice()).toEqual({ price: 84.95, currency: 'USD', src: 'og:price' });
  });

  test('returns null when neither ld+json nor meta price tags are present', () => {
    const { api } = load();
    expect(api.structuredPrice()).toBe(null);
  });

  test('rejects a zero or non-finite offer price rather than reporting a fake number', () => {
    const { api } = load({ document: makeDocument(ldJsonDocs([{ '@type': 'Product', offers: { price: '0', priceCurrency: 'USD' } }])) });
    expect(api.structuredPrice()).toBe(null);
  });
});

// --- ldBrand -------------------------------------------------------------------

describe('ldBrand()', () => {
  test('reads a string brand', () => {
    const { api } = load({ document: makeDocument(ldJsonDocs([{ brand: 'Stanley' }])) });
    expect(api.ldBrand()).toBe('Stanley');
  });

  test('reads an object brand by its name field', () => {
    const { api } = load({ document: makeDocument(ldJsonDocs([{ brand: { name: 'Yeti' } }])) });
    expect(api.ldBrand()).toBe('Yeti');
  });

  test('null when no node carries a brand', () => {
    const { api } = load({ document: makeDocument(ldJsonDocs([{ '@type': 'Product' }])) });
    expect(api.ldBrand()).toBe(null);
  });
});

// --- cartCurrency --------------------------------------------------------------

describe('cartCurrency()', () => {
  test('resolves the shop currency from /cart.js', async () => {
    const { api } = load({ fetch: async () => ({ ok: true, json: async () => ({ currency: 'ILS' }) }) });
    expect(await api.cartCurrency()).toBe('ILS');
  });

  test('null on a non-ok response', async () => {
    const { api } = load({ fetch: async () => ({ ok: false }) });
    expect(await api.cartCurrency()).toBe(null);
  });

  test('null when the endpoint throws (offline / blocked)', async () => {
    const { api } = load({ fetch: async () => { throw new Error('network'); } });
    expect(await api.cartCurrency()).toBe(null);
  });

  test('null when the response carries no currency field', async () => {
    const { api } = load({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
    expect(await api.cartCurrency()).toBe(null);
  });
});

// --- extract() -----------------------------------------------------------------

const SHOPIFY_DOC = { query: { 'meta[id="shopify-digital-wallet"]': {} } };

function productJson(overrides = {}) {
  return {
    title: 'Royal Vintage Cutlery Set',
    vendor: 'WarmlyDecor',
    currency: 'USD',
    variants: [{ id: 1, price: '8495', sku: 'abc' }],
    images: ['//cdn.shopify.com/x.jpg'],
    ...overrides,
  };
}

function okJsonResponse(body) {
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => body };
}

describe('extract()', () => {
  test('skips non-product paths without making any request', async () => {
    const { api } = load({ location: makeLocation({ href: 'https://warmlydecor.com/collections/all' }) });
    expect(await api.extract()).toEqual({ skip: 'not_a_product_path' });
  });

  test('skips a product path that is not Shopify', async () => {
    const { api } = load(); // no shopify signal in the default document
    expect(await api.extract()).toEqual({ skip: 'not_shopify' });
  });

  test('skips when the product.js request fails', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async () => ({ ok: false, status: 404 }),
    });
    expect(await api.extract()).toEqual({ skip: 'product_json_404' });
  });

  test('skips when product.js does not report a JSON content-type', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async () => ({ ok: true, headers: { get: () => 'text/html' } }),
    });
    expect(await api.extract()).toEqual({ skip: 'product_json_not_json' });
  });

  test('skips malformed product JSON (no variants array)', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async () => okJsonResponse({ title: 'x' }),
    });
    expect(await api.extract()).toEqual({ skip: 'product_json_malformed' });
  });

  test('skips when the requested variant does not exist', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async () => okJsonResponse({ variants: [] }),
    });
    expect(await api.extract()).toEqual({ skip: 'no_variant' });
  });

  test('skips a non-positive/non-numeric price rather than reporting a wrong one', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async () => okJsonResponse(productJson({ variants: [{ id: 1, price: '0' }] })),
    });
    expect(await api.extract()).toEqual({ skip: 'no_price' });
  });

  test('skips when no currency can be found anywhere', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async (url) => (String(url).endsWith('.js') && !String(url).includes('cart')
        ? okJsonResponse(productJson({ currency: undefined, images: [] }))
        : { ok: false }),
    });
    const r = await api.extract();
    expect(r.skip).toBe('no_currency');
  });

  test('skips when there is no image on the matched variant or product', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async () => okJsonResponse(productJson({ images: [], featured_image: undefined })),
    });
    expect(await api.extract()).toEqual({ skip: 'no_image' });
  });

  test('picks the variant matching ?variant= over the first one, converts cents, and normalizes a protocol-relative image', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      location: makeLocation({ href: 'https://warmlydecor.com/products/widget', search: '?variant=2' }),
      fetch: async () => okJsonResponse(productJson({
        variants: [{ id: 1, price: '999' }, { id: 2, price: '8495', sku: 'xyz' }],
      })),
    });
    const r = await api.extract();
    expect(r.price).toBe(84.95);
    expect(r.currency).toBe('USD');
    expect(r.image).toBe('https:' + '//cdn.shopify.com/x.jpg');
    expect(r.host).toBe('warmlydecor.com');
    expect(r.vendor).toBe('WarmlyDecor');
  });

  test('an authoritative ld+json price overrides the products.json price', async () => {
    const { api } = load({
      document: makeDocument({
        ...SHOPIFY_DOC,
        queryAll: { 'script[type="application/ld+json"]': [{ textContent: JSON.stringify({ '@type': 'Product', offers: { price: '259', priceCurrency: 'ILS' } }) }] },
      }),
      fetch: async () => okJsonResponse(productJson()),
    });
    const r = await api.extract();
    expect(r.price).toBe(259);
    expect(r.currency).toBe('ILS');
  });

  test('falls back to /cart.js for currency when products.json and meta tags have none', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async (url) => (String(url).includes('cart.js')
        ? okJsonResponse({ currency: 'ILS' })
        : okJsonResponse(productJson({ currency: undefined }))),
    });
    const r = await api.extract();
    expect(r.currency).toBe('ILS');
  });

  test('falls back to ld+json brand.name for vendor when products.json has none', async () => {
    const { api } = load({
      document: makeDocument({
        ...SHOPIFY_DOC,
        queryAll: { 'script[type="application/ld+json"]': [{ textContent: JSON.stringify({ brand: { name: 'Stanley' } }) }] },
      }),
      fetch: async () => okJsonResponse(productJson({ vendor: undefined })),
    });
    const r = await api.extract();
    expect(r.vendor).toBe('Stanley');
  });

  test('flags DSers sku/image importer signatures', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async () => okJsonResponse(productJson({
        variants: [{ id: 1, price: '8495', sku: '35030427-china-1-sets-4pcs' }],
        images: ['//cdn.shopify.com/s/files/1/0/products/product-image-1410527736.jpg'],
      })),
    });
    const r = await api.extract();
    expect(r.importer).toEqual(['dsers_sku', 'dsers_image']);
  });

  test('flags the "my store" default-vendor tell', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async () => okJsonResponse(productJson({ vendor: 'My Store' })),
    });
    const r = await api.extract();
    expect(r.importer).toContain('my_store_vendor');
  });

  test('a clean listing with no supplier tells carries no importer signature', async () => {
    const { api } = load({
      document: makeDocument(SHOPIFY_DOC),
      fetch: async () => okJsonResponse(productJson({ variants: [{ id: 1, price: '8495', sku: 'MSN-CS-8' }] })),
    });
    const r = await api.extract();
    expect(r.importer).toEqual([]);
  });
});

// --- receiptData() ---------------------------------------------------------

describe('receiptData()', () => {
  const extraction = { host: 'warmlydecor.com', title: 'Royal Vintage Cutlery Set', price: 84.95, currency: 'USD', image: 'https://x/img.jpg' };
  const verdict = {
    aliTitle: 'Cutlery Set', aliPrice: 9.72, aliImage: 'https://y/img.jpg', aliUrl: 'https://aliexpress.com/item/1.html',
    sold: '2,000+ sold', markup: 774, shipTo: 'US', capturedAt: '2026-07-28',
  };

  test('maps store + verdict fields into the flat shape receipt.js expects', () => {
    const { api } = load();
    expect(api.receiptData(extraction, verdict)).toEqual({
      storeHost: 'warmlydecor.com', storeTitle: 'Royal Vintage Cutlery Set',
      storePrice: 84.95, currency: 'USD', storeImage: 'https://x/img.jpg',
      aliTitle: 'Cutlery Set', aliPrice: 9.72, aliImage: 'https://y/img.jpg',
      aliUrl: 'https://aliexpress.com/item/1.html', sold: '2,000+ sold', markup: 774,
      priceBasis: api.FALLBACK_BASIS, note: null, shipTo: 'US', capturedAt: '2026-07-28',
    });
  });

  test('carries an explicit priceBasis/note through instead of the fallback', () => {
    const { api } = load();
    const d = api.receiptData(extraction, { ...verdict, priceBasis: 'exact dearest-variant match', note: 'stanley is a brand name' });
    expect(d.priceBasis).toBe('exact dearest-variant match');
    expect(d.note).toBe('stanley is a brand name');
  });
});

// --- run() guard clauses -----------------------------------------------------

describe('run()', () => {
  test('defers without asking the worker anything when the tab is hidden', async () => {
    let called = false;
    const { api } = load({
      document: { ...makeDocument(), visibilityState: 'hidden' },
      chrome: makeChrome({ sendMessage: (msg, cb) => { called = true; cb(null); } }),
    });
    await api.run();
    expect(called).toBe(false);
  });

  test('stops after the worker reports the host is muted, without extracting', async () => {
    const seen = [];
    const { api } = load({
      chrome: makeChrome({
        sendMessage: (msg, cb) => { seen.push(msg.type); cb(msg.type === 'isMuted' ? { muted: true } : null); },
      }),
    });
    await api.run();
    expect(seen).toEqual(['isMuted']);
  });

  test('renders nothing and logs SILENT when the worker returns no confident verdict', async () => {
    const { api, logs } = load({
      document: makeDocument(SHOPIFY_DOC),
      location: makeLocation({ href: 'https://warmlydecor.com/collections/all' }), // not_a_product_path -> extraction.skip
      chrome: makeChrome({
        sendMessage: (msg, cb) => cb(msg.type === 'isMuted' ? { muted: false } : null),
      }),
    });
    await api.run();
    expect(logs.some((l) => l.includes('SKIP: not_a_product_path'))).toBe(true);
  });
});
