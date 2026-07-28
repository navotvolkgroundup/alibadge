// bun test
// worker.js owns every chrome.* call and every network call, so this file's whole job
// is faking those two boundaries and exercising the logic behind them: the token
// bucket, the cache (TTL + LRU eviction), the MTOP retry-on-expired-token dance, the
// results parser, the perceptual-hash gate plumbing, and the pipeline/messaging
// orchestration in lookup()/judge(). worker.js had no exports at all before this file;
// the minimal change made to enable testing was adding `export` to the functions and
// constants exercised below — no behavior was changed.
//
// UI rendering and the manual console diagnostics (__alibadgePdp, __alibadgeLabelset*,
// __alibadgeProbeUrl) are out of scope: they are debug-only entry points with no
// decision logic of their own, layered on top of what is already tested here.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { HASH_MAX_DISTANCE } from './lib.js';

// --- chrome.* mock -----------------------------------------------------------
// Installed on globalThis BEFORE worker.js is imported (dynamic import, below) so its
// top-level code (chrome.storage.local.get, the three addListener calls) has
// something to call. Real chrome.storage semantics: get(null) returns everything,
// get(string|array) returns only present keys, set/remove operate on the same bag.

let storageData;
let cookieData;
const listeners = { onInstalled: null, onMessage: null, tabsOnUpdated: null };
const sentTabMessages = [];

function makeChromeMock() {
  storageData = {};
  cookieData = {};
  return {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return { ...storageData };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in storageData) out[k] = storageData[k];
          return out;
        },
        async set(obj) {
          Object.assign(storageData, obj);
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete storageData[k];
        },
      },
    },
    cookies: {
      async get({ name }) {
        return name in cookieData ? { value: cookieData[name] } : null;
      },
      async set({ name, value }) {
        cookieData[name] = value;
      },
      async remove({ name }) {
        delete cookieData[name];
      },
    },
    runtime: {
      onInstalled: { addListener: (fn) => { listeners.onInstalled = fn; } },
      onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
      openOptionsPage: mock(() => {}),
      getURL: (p) => `chrome-extension://test-id/${p}`,
    },
    tabs: {
      onUpdated: { addListener: (fn) => { listeners.tabsOnUpdated = fn; } },
      sendMessage: mock((tabId, msg) => {
        sentTabMessages.push([tabId, msg]);
        return Promise.resolve();
      }),
    },
  };
}

globalThis.chrome = makeChromeMock();

const w = await import('./worker.js');

// --- fake canvas / image pipeline --------------------------------------------
// createImageBitmap/OffscreenCanvas do not exist in bun. worker.js already treats
// their absence as an ordinary failure (try/catch -> null), which is itself tested
// below. For the tests that need a *working* image pipeline, this installs a fake
// one that ignores actual pixel content and returns caller-controlled data, so the
// dHash/downscale CONTROL FLOW can be exercised without a real image decoder.
function installCanvasMocks({ imageData, blobSize } = {}) {
  globalThis.createImageBitmap = async () => ({ width: 9, height: 8, close() {} });
  globalThis.OffscreenCanvas = class {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() {
      return {
        drawImage() {},
        getImageData: () => ({ data: imageData }),
      };
    }
    async convertToBlob({ quality } = {}) {
      const size = typeof blobSize === 'function' ? blobSize(quality) : (blobSize ?? 10);
      return { size, async arrayBuffer() { return new Uint8Array(size).buffer; } };
    }
  };
}
function uninstallCanvasMocks() {
  delete globalThis.createImageBitmap;
  delete globalThis.OffscreenCanvas;
}

function fakeRes(status, overrides = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() { return new Uint8Array([1, 2, 3, 4]).buffer; },
    async blob() { return { size: 4 }; },
    async json() { return null; },
    async text() { return ''; },
    ...overrides,
  };
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// Wraps a candidate item list in the exact envelope fetchResults()/lookup() dig
// through (data.data.root.fields.mods.itemList.content), so no test has to hand-count
// the nesting.
function resultsBody(items) {
  return JSON.stringify({ data: { data: { root: { fields: { mods: { itemList: { content: items } } } } } } });
}

beforeEach(() => {
  storageData = {};
  cookieData = {};
  sentTabMessages.length = 0;
});

afterEach(() => {
  uninstallCanvasMocks();
  delete globalThis.fetch;
});

// --- findKey ------------------------------------------------------------------

describe('findKey', () => {
  test('finds a key at any depth', () => {
    expect(w.findKey({ a: { b: { c: 'deep' } } }, 'c')).toBe('deep');
  });

  test('returns null when absent, non-object, or too deep', () => {
    expect(w.findKey({ a: 1 }, 'missing')).toBe(null);
    expect(w.findKey(null, 'x')).toBe(null);
    expect(w.findKey('string', 'x')).toBe(null);
    let deep = { v: 'bottom' };
    for (let i = 0; i < 10; i++) deep = { nest: deep };
    expect(w.findKey(deep, 'v')).toBe(null); // 10 levels exceeds the d > 8 cutoff
  });

  test('skips a falsy value and keeps looking, rather than stopping at 0 or ""', () => {
    const o = { skuPriceInfoMap: 0, nested: { skuPriceInfoMap: { a: 1 } } };
    expect(w.findKey(o, 'skuPriceInfoMap')).toEqual({ a: 1 });
  });
});

// --- gateFromStored -------------------------------------------------------------

describe('gateFromStored', () => {
  test('a null distance never passes, and reports Infinity, not null', () => {
    const g = w.gateFromStored([{ productId: '1', d: null }]);
    expect(g[0].distance).toBe(Infinity);
    expect(g[0].passes).toBe(false);
  });

  test('a distance at or under the threshold passes; over it does not', () => {
    const g = w.gateFromStored([
      { productId: 'near', d: HASH_MAX_DISTANCE },
      { productId: 'far', d: HASH_MAX_DISTANCE + 1 },
    ]);
    expect(g[0].passes).toBe(true);
    expect(g[1].passes).toBe(false);
  });
});

// --- cacheGet / cachePut --------------------------------------------------------

describe('cacheGet / cachePut', () => {
  test('put then get round-trips the value under the versioned key', async () => {
    await w.cachePut(['k1'], { results: [1, 2, 3] });
    expect(storageData[`c:${w.CACHE_V}:k1`]).toBeTruthy();
    expect(await w.cacheGet(['k1'])).toEqual({ results: [1, 2, 3] });
  });

  test('an expired entry is treated as a miss', async () => {
    storageData[`c:${w.CACHE_V}:old`] = { t: Date.now() - 8 * 24 * 60 * 60 * 1000, v: 'stale' };
    expect(await w.cacheGet(['old'])).toBe(null);
  });

  test('a miss on every key returns null, not undefined', async () => {
    expect(await w.cacheGet(['nope', 'also-nope'])).toBe(null);
  });

  test('checks each key in order and returns the first hit', async () => {
    await w.cachePut(['b'], 'from-b');
    expect(await w.cacheGet(['a-absent', 'b'])).toBe('from-b');
  });

  test('evicts the oldest entries once the store exceeds CACHE_MAX', async () => {
    const now = Date.now();
    for (let i = 0; i < w.CACHE_MAX; i++) {
      storageData[`c:${w.CACHE_V}:seed${i}`] = { t: now - (w.CACHE_MAX - i) * 1000, v: i };
    }
    await w.cachePut(['newest'], 'fresh');
    const keys = Object.keys(storageData).filter((k) => k.startsWith('c:'));
    expect(keys.length).toBe(w.CACHE_MAX);
    // seed0 was the oldest of the seeded entries and must be the one evicted.
    expect(storageData[`c:${w.CACHE_V}:seed0`]).toBeUndefined();
    expect(storageData[`c:${w.CACHE_V}:newest`]).toBeTruthy();
  });
});

// --- tokenFor -------------------------------------------------------------------

describe('tokenFor', () => {
  test('returns the part before the underscore', async () => {
    cookieData._m_h5_tk = 'abc123_1234567890';
    expect(await w.tokenFor('https://x.aliexpress.com')).toBe('abc123');
  });

  test('returns null when the cookie is absent', async () => {
    expect(await w.tokenFor('https://x.aliexpress.com')).toBe(null);
  });

  test('returns null rather than throwing when cookies.get rejects', async () => {
    const real = globalThis.chrome.cookies.get;
    globalThis.chrome.cookies.get = () => { throw new Error('no cookies permission'); };
    expect(await w.tokenFor('https://x.aliexpress.com')).toBe(null);
    globalThis.chrome.cookies.get = real;
  });
});

// --- uploadImage (MTOP handshake + retry) ---------------------------------------

describe('uploadImage', () => {
  test('succeeds on the first call', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      return fakeRes(200, { async json() { return { ret: 'SUCCESS', data: { fileId: 'FID1' } }; } });
    });
    expect(await w.uploadImage('b64==', 'USD')).toBe('FID1');
    expect(calls).toBe(1);
  });

  test('retries once on an expired/empty token and succeeds the second time', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls === 1) return fakeRes(200, { async json() { return { ret: 'FAIL_SYS_TOKEN_EXPIRED' }; } });
      return fakeRes(200, { async json() { return { ret: 'SUCCESS', data: { fileId: 'FID2' } }; } });
    });
    expect(await w.uploadImage('b64==', 'USD')).toBe('FID2');
    expect(calls).toBe(2);
  });

  test('the real-world typo FAIL_SYS_TOKEN_EXOIRED also triggers a retry', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls === 1) return fakeRes(200, { async json() { return { ret: 'FAIL_SYS_TOKEN_EXOIRED' }; } });
      return fakeRes(200, { async json() { return { ret: 'SUCCESS', data: { fileId: 'FID3' } }; } });
    });
    expect(await w.uploadImage('b64==', 'USD')).toBe('FID3');
  });

  test('returns null, never throws, when no fileId ever comes back', async () => {
    globalThis.fetch = mock(async () => fakeRes(200, { async json() { return { ret: 'FAIL_SOMETHING_ELSE' }; } }));
    expect(await w.uploadImage('b64==', 'USD')).toBe(null);
  });

  test('returns null when the response body is not valid JSON', async () => {
    globalThis.fetch = mock(async () => fakeRes(200, { async json() { throw new SyntaxError('bad json'); } }));
    expect(await w.uploadImage('b64==', 'USD')).toBe(null);
  });
});

// --- pdpDearest ------------------------------------------------------------------

describe('pdpDearest', () => {
  test('returns the dearest sku price on success', async () => {
    globalThis.fetch = mock(async () => fakeRes(200, {
      async json() {
        return {
          ret: 'SUCCESS',
          data: { result: { skuPriceInfoMap: {
            a: { salePriceString: '$6.28', originalPrice: { currency: 'USD' } },
            b: { salePriceString: '$9.80', originalPrice: { currency: 'USD' } },
          } } },
        };
      },
    }));
    expect(await w.pdpDearest('123', 'USD')).toBe(9.8);
  });

  test('a punished response yields null, not a thrown error', async () => {
    globalThis.fetch = mock(async () => fakeRes(200, { async json() { return { ret: 'FAIL_SYS_USER_VALIDATE' }; } }));
    expect(await w.pdpDearest('123', 'USD')).toBe(null);
  });

  test('an unparseable/absent skuPriceInfoMap yields null', async () => {
    globalThis.fetch = mock(async () => fakeRes(200, { async json() { return { ret: 'SUCCESS', data: {} }; } }));
    expect(await w.pdpDearest('123', 'USD')).toBe(null);
  });

  test('retries once on an expired token', async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls === 1) return fakeRes(200, { async json() { return { ret: 'FAIL_SYS_TOKEN_EMPTY' }; } });
      return fakeRes(200, {
        async json() {
          return { ret: 'SUCCESS', data: { result: { skuPriceInfoMap: {
            a: { salePriceString: '$5.00', originalPrice: { currency: 'USD' } },
          } } } };
        },
      });
    });
    expect(await w.pdpDearest('123', 'USD')).toBe(5);
    expect(calls).toBe(2);
  });
});

// --- withStoreCurrency -----------------------------------------------------------

describe('withStoreCurrency', () => {
  test('sets the currency cookie for fn(), then restores the prior value', async () => {
    cookieData.aep_usuc_f = 'site=glo&c_tp=ILS&region=IL&b_locale=he';
    let seenDuring;
    await w.withStoreCurrency('USD', async () => { seenDuring = cookieData.aep_usuc_f; });
    expect(seenDuring).toContain('c_tp=USD');
    expect(cookieData.aep_usuc_f).toBe('site=glo&c_tp=ILS&region=IL&b_locale=he');
  });

  test('removes the cookie afterward when there was none before', async () => {
    delete cookieData.aep_usuc_f;
    await w.withStoreCurrency('USD', async () => {});
    expect(cookieData.aep_usuc_f).toBeUndefined();
  });

  test('restores the cookie even when fn() throws', async () => {
    cookieData.aep_usuc_f = 'prior-value';
    await expect(w.withStoreCurrency('USD', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(cookieData.aep_usuc_f).toBe('prior-value');
  });
});

// --- fetchResults ------------------------------------------------------------------

describe('fetchResults', () => {
  test('a non-ok response throws with httpStatus attached', async () => {
    globalThis.fetch = mock(async () => fakeRes(403));
    await expect(w.fetchResults('FID')).rejects.toMatchObject({ httpStatus: 403 });
  });

  test('a punish-wall body throws a marked punished error even on HTTP 200', async () => {
    globalThis.fetch = mock(async () => fakeRes(200, { async text() { return '<html>_____tmd_____/punish</html>'; } }));
    await expect(w.fetchResults('FID')).rejects.toMatchObject({ punished: true });
  });

  test('gives up and returns [] once the retry budget (attempt 4) is spent', async () => {
    globalThis.fetch = mock(async () => fakeRes(200, { async text() { return JSON.stringify({ data: {} }); } }));
    expect(await w.fetchResults('FID', 4)).toEqual([]);
  });

  test('retries an empty item list before giving up', async () => {
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls === 1) return fakeRes(200, { async text() { return JSON.stringify({ data: {} }); } });
      return fakeRes(200, { async text() {
        return resultsBody([
          { productId: 'p1', title: { displayTitle: 'X' }, prices: { salePrice: { minPrice: '1.00', currencyCode: 'USD' } } },
        ]);
      } });
    });
    const items = await w.fetchResults('FID');
    expect(calls).toBe(2);
    expect(items).toHaveLength(1);
    globalThis.setTimeout = realTimeout;
  });

  test('maps fields correctly: sale price over original, https-prefixed image, filters no-productId rows', async () => {
    globalThis.fetch = mock(async () => fakeRes(200, { async text() {
      return resultsBody([
        {
          productId: '111', title: { displayTitle: 'Cutlery Set' },
          image: { imgUrl: '//ae01.alicdn.com/kf/x.jpg' },
          prices: { salePrice: { minPrice: '9.72', currencyCode: 'USD' } },
          trade: { tradeDesc: '500 sold' },
        },
        { title: { displayTitle: 'no id, must be dropped' } },
      ]);
    } }));
    const items = await w.fetchResults('FID');
    expect(items).toEqual([{
      productId: '111', title: 'Cutlery Set', image: 'https://ae01.alicdn.com/kf/x.jpg',
      price: '9.72', currency: 'USD', sold: '500 sold', url: 'https://www.aliexpress.com/item/111.html',
    }]);
  });
});

// --- encodeForUpload ---------------------------------------------------------------

describe('encodeForUpload', () => {
  test('a buffer within the size cap is base64-encoded as-is, unresized', async () => {
    const buf = new Uint8Array([10, 20, 30, 40]).buffer;
    const { b64, resized } = await w.encodeForUpload(buf);
    expect(resized).toBe(false);
    expect([...b64ToBytes(b64)]).toEqual([10, 20, 30, 40]);
  });

  test('an oversized buffer without a working image decoder falls back to the original, unresized', async () => {
    const buf = new ArrayBuffer(w.UPLOAD_MAX_BYTES + 1);
    const { b64, resized } = await w.encodeForUpload(buf);
    expect(resized).toBe(false);
    expect(b64ToBytes(b64).byteLength).toBe(w.UPLOAD_MAX_BYTES + 1);
  });

  test('an oversized buffer is downscaled, and retries at lower quality if still too big', async () => {
    installCanvasMocks({
      imageData: new Uint8ClampedArray(9 * 8 * 4),
      blobSize: (quality) => (quality === 0.9 ? w.UPLOAD_MAX_BYTES + 1 : w.UPLOAD_MAX_BYTES - 1),
    });
    const buf = new ArrayBuffer(w.UPLOAD_MAX_BYTES + 1);
    const { b64, resized } = await w.encodeForUpload(buf);
    expect(resized).toBe(true);
    expect(b64ToBytes(b64).byteLength).toBe(w.UPLOAD_MAX_BYTES - 1);
  });
});

// --- dhashOf ------------------------------------------------------------------------

describe('dhashOf', () => {
  test('returns null rather than throwing when there is no image decoder available', async () => {
    expect(await w.dhashOf(new Uint8Array([1, 2, 3]).buffer)).toBe(null);
  });

  test('computes the documented dHash: one bit per horizontal luma gradient', async () => {
    // 9 columns x 8 rows, RGBA. Column 0 dark, rising to column 8 bright, on every
    // row: each of the 8 comparisons in a row is lum[col] < lum[col+1], i.e. all 1s.
    const data = new Uint8ClampedArray(9 * 8 * 4);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 9; c++) {
        const i = (r * 9 + c) * 4;
        const v = c * 28; // strictly increasing across the row
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
      }
    }
    installCanvasMocks({ imageData: data });
    const hash = await w.dhashOf(new Uint8Array([0]).buffer);
    expect(hash).toBe('1'.repeat(64));
  });
});

// --- gateFor ------------------------------------------------------------------------

describe('gateFor', () => {
  test('returns null outright when the STORE photo cannot be hashed, regardless of candidates', async () => {
    // No canvas installed: dhashOf(storeBuf) resolves null, and gateFor must not fall
    // back to ranking candidates on their own — see the i-cell measured failure.
    const results = [{ productId: '1', image: 'https://ae01.alicdn.com/kf/a.jpg' }];
    expect(await w.gateFor(new Uint8Array([1]).buffer, results)).toBe(null);
  });

  test('a candidate with no image gets a null hash and fails the gate', async () => {
    installCanvasMocks({ imageData: new Uint8ClampedArray(9 * 8 * 4) });
    const results = [{ productId: '1', image: null }];
    const gate = await w.gateFor(new Uint8Array([1]).buffer, results);
    expect(gate[0].distance).toBe(Infinity);
    expect(gate[0].passes).toBe(false);
  });

  test('falls back to the alicdn host when aliexpress-media.com is blocked, and still hashes', async () => {
    installCanvasMocks({ imageData: new Uint8ClampedArray(9 * 8 * 4) });
    const fetched = [];
    globalThis.fetch = mock(async (url) => {
      fetched.push(String(url));
      if (String(url).includes('aliexpress-media.com')) return fakeRes(0); // blocked/failed
      return fakeRes(200);
    });
    const results = [{ productId: '1', image: 'https://sub.aliexpress-media.com/kf/a.jpg' }];
    const gate = await w.gateFor(new Uint8Array([1]).buffer, results);
    expect(fetched.some((u) => u.includes('aliexpress-media.com'))).toBe(true);
    expect(fetched.some((u) => u.startsWith('https://ae01.alicdn.com/'))).toBe(true);
    expect(gate[0].distance).toBe(0); // identical fake pixel data on both sides
    expect(gate[0].passes).toBe(true);
  });

  test('a network error fetching the candidate image is swallowed, not thrown', async () => {
    installCanvasMocks({ imageData: new Uint8ClampedArray(9 * 8 * 4) });
    globalThis.fetch = mock(async () => { throw new Error('network down'); });
    const results = [{ productId: '1', image: 'https://ae01.alicdn.com/kf/a.jpg' }];
    const gate = await w.gateFor(new Uint8Array([1]).buffer, results);
    expect(gate[0].passes).toBe(false);
  });
});

// --- thumb --------------------------------------------------------------------------

describe('thumb', () => {
  test('null in, null out, no fetch attempted', async () => {
    globalThis.fetch = mock(async () => { throw new Error('must not be called'); });
    expect(await w.thumb(null)).toBe(null);
  });

  test('a failed fetch yields null', async () => {
    globalThis.fetch = mock(async () => fakeRes(404));
    expect(await w.thumb('https://ae01.alicdn.com/kf/a.jpg')).toBe(null);
  });

  test('a thrown fetch is swallowed as null', async () => {
    globalThis.fetch = mock(async () => { throw new Error('down'); });
    expect(await w.thumb('https://ae01.alicdn.com/kf/a.jpg')).toBe(null);
  });

  test('a successful fetch with a working decoder returns a data URL', async () => {
    installCanvasMocks({ imageData: new Uint8ClampedArray(9 * 8 * 4), blobSize: 6 });
    globalThis.fetch = mock(async () => fakeRes(200));
    const out = await w.thumb('https://ae01.alicdn.com/kf/a.jpg');
    expect(out.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});

// --- judge --------------------------------------------------------------------------
// judge() consumes results that already carry a precomputed `d` (hash distance), so
// these tests control the gate outcome directly and need no image decoder at all.

describe('judge', () => {
  const store = {
    price: 84.95, currency: 'USD', title: 'Royal Vintage Cutlery Set',
    host: 'warmlydecor.com', importer: ['dsers_sku', 'dsers_image'], image: null,
  };

  test('renders full, with the upper-bound price basis, when nothing upgraded the price', async () => {
    const results = [{ productId: '1', price: '$9.72', currency: 'USD', title: 'x', d: 0, image: null }];
    const out = await w.judge(store, { fileId: 'FID', results });
    expect(out.render).toBe('full');
    expect(out.priceBasis).toBe('matched listing, cheapest variant — markup is an upper bound');
    expect(out.aliPrice).toBe(9.72);
    expect(out.markup).toBeGreaterThan(0);
    expect(out.searchUrl).toContain('filename=FID');
  });

  test('reports the dearest-variant basis when the winner carries basis: "dearest"', async () => {
    const results = [{ productId: '1', price: 18.24, currency: 'USD', title: 'x', d: 0, image: null, basis: 'dearest' }];
    const out = await w.judge(store, { fileId: 'FID', results });
    expect(out.priceBasis).toBe('matched listing, dearest variant');
    expect(out.aliPrice).toBe(18.24);
  });

  test('with no winner, carries only the base fields — no aliPrice/thumbs/markup, and no image fetches', async () => {
    globalThis.fetch = mock(async () => { throw new Error('must not be called without a winner'); });
    const out = await w.judge(store, { fileId: 'FID', results: [] });
    expect(out.render).toBe('link-only');
    expect(out).not.toHaveProperty('aliPrice');
    expect(out).not.toHaveProperty('storeThumb');
  });
});

// --- lookup -------------------------------------------------------------------------

const ORIGIN = 'https://warmlydecor.com';
const STORE_IMAGE = 'https://cdn.shopify.com/s/files/1/x/product-image-1.jpg';

function baseExtraction(overrides = {}) {
  return {
    url: 'https://warmlydecor.com/products/royal-vintage-cutlery-set',
    host: 'warmlydecor.com', title: 'Royal Vintage Cutlery Set', vendor: 'Warmly',
    price: 84.95, currency: 'USD', image: STORE_IMAGE,
    importer: ['dsers_sku', 'dsers_image'],
    ...overrides,
  };
}

describe('lookup', () => {
  test('refuses to run before consent, and touches neither cache nor network', async () => {
    globalThis.fetch = mock(async () => { throw new Error('must not be called'); });
    const out = await w.lookup(baseExtraction(), ORIGIN);
    expect(out).toEqual({ render: 'none', reasons: ['no_consent'] });
  });

  test('an allowed image URL is required even with consent', async () => {
    storageData.consent = true;
    const out = await w.lookup(baseExtraction({ image: 'https://evil.example.com/x.jpg' }), ORIGIN);
    expect(out).toEqual({ render: 'none', reasons: ['image_url_disallowed'] });
  });

  test('a failed image fetch is reported distinctly from a disallowed URL', async () => {
    storageData.consent = true;
    globalThis.fetch = mock(async () => fakeRes(500));
    const out = await w.lookup(baseExtraction(), ORIGIN);
    expect(out).toEqual({ render: 'none', reasons: ['image_fetch_failed'] });
  });

  test('a URL-keyed cache hit answers without any network call', async () => {
    storageData.consent = true;
    globalThis.fetch = mock(async () => { throw new Error('must not be called on a cache hit'); });
    const extraction = baseExtraction();
    await w.cachePut(
      [`${extraction.url.split('?')[0]}`],
      { fileId: 'CACHED', results: [{ productId: '1', price: '$9.72', currency: 'USD', title: 'x', d: 0, image: null }] },
    );
    const out = await w.lookup(extraction, ORIGIN);
    expect(out.render).toBe('full');
    expect(out.searchUrl).toContain('CACHED');
  });

  test('a byte-keyed cache hit (same photo, different URL) skips upload and search', async () => {
    storageData.consent = true;
    const bytes = new Uint8Array([9, 9, 9]);
    globalThis.fetch = mock(async (url) => {
      if (String(url) === STORE_IMAGE) return fakeRes(200, { async arrayBuffer() { return bytes.buffer; } });
      throw new Error('must not upload or search on a byte cache hit: ' + url);
    });
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    await w.cachePut([hex], {
      fileId: 'BYTECACHE', results: [{ productId: '1', price: '$9.72', currency: 'USD', title: 'x', d: 0, image: null }],
    });
    const out = await w.lookup(baseExtraction({ url: 'https://warmlydecor.com/products/other-page' }), ORIGIN);
    expect(out.render).toBe('full');
    expect(out.searchUrl).toContain('BYTECACHE');
  });

  test('upload failure is reported and never reaches the results search', async () => {
    storageData.consent = true;
    globalThis.fetch = mock(async (url) => {
      if (String(url) === STORE_IMAGE) return fakeRes(200);
      if (String(url).startsWith('https://recom-acs.aliexpress.com')) {
        return fakeRes(200, { async json() { return { ret: 'FAIL_SYS_TOKEN_EMPTY' }; } });
      }
      throw new Error('must not reach results search after an upload failure: ' + url);
    });
    const out = await w.lookup(baseExtraction(), ORIGIN);
    expect(out).toEqual({ render: 'none', reasons: ['upload_failed'] });
  });

  test('a punished results search degrades to link-only with a working search URL, not silence', async () => {
    storageData.consent = true;
    globalThis.fetch = mock(async (url) => {
      const u = String(url);
      if (u === STORE_IMAGE) return fakeRes(200);
      if (u.startsWith('https://recom-acs.aliexpress.com')) {
        return fakeRes(200, { async json() { return { ret: 'SUCCESS', data: { fileId: 'FIDX' } }; } });
      }
      if (u.includes('/fn/search-pc/index')) {
        return fakeRes(200, { async text() { return '<html>_____tmd_____/punish</html>'; } });
      }
      throw new Error('unexpected fetch: ' + u);
    });
    const out = await w.lookup(baseExtraction(), ORIGIN);
    expect(out.render).toBe('link-only');
    expect(out.reasons).toEqual(['punished']);
    expect(out.searchUrl).toContain('FIDX');
  });

  test('an HTTP error from the results search reports the status and still hands back a link', async () => {
    storageData.consent = true;
    globalThis.fetch = mock(async (url) => {
      const u = String(url);
      if (u === STORE_IMAGE) return fakeRes(200);
      if (u.startsWith('https://recom-acs.aliexpress.com')) {
        return fakeRes(200, { async json() { return { ret: 'SUCCESS', data: { fileId: 'FIDY' } }; } });
      }
      if (u.includes('/fn/search-pc/index')) return fakeRes(403);
      throw new Error('unexpected fetch: ' + u);
    });
    const out = await w.lookup(baseExtraction(), ORIGIN);
    expect(out.render).toBe('link-only');
    expect(out.reasons).toEqual(['results_http_403']);
  });

  test('empty results are judged but never cached (a transient miss must not become a week of silence)', async () => {
    storageData.consent = true;
    // fetchResults retries an empty item list up to 4 attempts with a real setTimeout
    // backoff; collapse it so the test doesn't spend 7+ real seconds waiting it out.
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    globalThis.fetch = mock(async (url) => {
      const u = String(url);
      if (u === STORE_IMAGE) return fakeRes(200);
      if (u.startsWith('https://recom-acs.aliexpress.com')) {
        return fakeRes(200, { async json() { return { ret: 'SUCCESS', data: { fileId: 'FIDZ' } }; } });
      }
      if (u.includes('/fn/search-pc/index')) return fakeRes(200, { async text() { return JSON.stringify({ data: {} }); } });
      throw new Error('unexpected fetch: ' + u);
    });
    const out = await w.lookup(baseExtraction(), ORIGIN);
    globalThis.setTimeout = realTimeout;
    expect(out.render).toBe('link-only'); // decide(): a fileId exists but no results to compare against
    expect(Object.keys(storageData).filter((k) => k.startsWith('c:'))).toHaveLength(0);
  });

  test('without a working image decoder, a real result is fetched, gated shut (fails closed), and only THEN cached', async () => {
    storageData.consent = true;
    globalThis.fetch = mock(async (url) => {
      const u = String(url);
      if (u === STORE_IMAGE) return fakeRes(200);
      if (u.startsWith('https://recom-acs.aliexpress.com')) {
        return fakeRes(200, { async json() { return { ret: 'SUCCESS', data: { fileId: 'FIDW' } }; } });
      }
      if (u.includes('/fn/search-pc/index')) {
        return fakeRes(200, { async text() {
          return resultsBody([
            { productId: '1', title: { displayTitle: 'Cutlery' }, image: { imgUrl: '//ae01.alicdn.com/kf/a.jpg' },
              prices: { salePrice: { minPrice: '9.72', currencyCode: 'USD' } } },
          ]);
        } });
      }
      throw new Error('unexpected fetch: ' + u);
    });
    const out = await w.lookup(baseExtraction(), ORIGIN);
    // No canvas available in this test -> the store photo cannot be hashed -> the gate
    // rejects every candidate, exactly the i-cell failure mode the gate exists to stop.
    expect(out.render).toBe('link-only');
    expect(out.reasons).toContain('no_passing_match');
    const cached = Object.entries(storageData).find(([k]) => k.startsWith('c:'));
    expect(cached).toBeTruthy();
    expect(cached[1].v.results[0].d).toBe(null);
  });

  test('end to end: a gated photo match with importer plumbing renders full and upgrades to the dearest variant', async () => {
    storageData.consent = true;
    installCanvasMocks({ imageData: new Uint8ClampedArray(9 * 8 * 4) }); // identical fake hash everywhere -> distance 0
    globalThis.fetch = mock(async (url) => {
      const u = String(url);
      if (u === STORE_IMAGE) return fakeRes(200);
      if (u.startsWith('https://recom-acs.aliexpress.com')) {
        return fakeRes(200, { async json() { return { ret: 'SUCCESS', data: { fileId: 'FIDFULL' } }; } });
      }
      if (u.includes('/fn/search-pc/index')) {
        return fakeRes(200, { async text() {
          return resultsBody([
            { productId: '1', title: { displayTitle: 'Cutlery' }, image: { imgUrl: '//ae01.alicdn.com/kf/a.jpg' },
              prices: { salePrice: { minPrice: '9.72', currencyCode: 'USD' } } },
          ]);
        } });
      }
      if (u.startsWith('https://ae01.alicdn.com')) return fakeRes(200); // candidate photo + thumbnails
      if (u.startsWith('https://acs.aliexpress.com')) {
        return fakeRes(200, { async json() {
          return { ret: 'SUCCESS', data: { result: { skuPriceInfoMap: {
            a: { salePriceString: '$18.24', originalPrice: { currency: 'USD' } },
          } } } };
        } });
      }
      throw new Error('unexpected fetch: ' + u);
    });
    const out = await w.lookup(baseExtraction(), ORIGIN);
    expect(out.render).toBe('full');
    expect(out.reasons).toEqual([]);
    expect(out.priceBasis).toBe('matched listing, dearest variant');
    expect(out.aliPrice).toBe(18.24);
    const cached = Object.entries(storageData).find(([k]) => k.startsWith('c:'));
    expect(cached[1].v.results[0].basis).toBe('dearest');
  });
});

// --- chrome.runtime.onMessage listener ------------------------------------------

describe('the worker message listener', () => {
  test('ignores a message not targeted at the worker', () => {
    const reply = mock(() => {});
    const handled = listeners.onMessage({ target: 'content', type: 'lookup' }, {}, reply);
    expect(handled).toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });

  test('isMuted reports the stored per-host mute state', async () => {
    storageData.muted = { 'example.com': true };
    const reply = mock(() => {});
    const handled = listeners.onMessage({ target: 'worker', type: 'isMuted', host: 'example.com' }, {}, reply);
    expect(handled).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(reply).toHaveBeenCalledWith({ muted: true });
  });

  test('mute persists the host and acknowledges', async () => {
    const reply = mock(() => {});
    listeners.onMessage({ target: 'worker', type: 'mute', host: 'shady.example' }, {}, reply);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(storageData.muted).toEqual({ 'shady.example': true });
    expect(reply).toHaveBeenCalledWith({ ok: true });
  });

  test('firstRunSeen is true exactly once', async () => {
    const reply1 = mock(() => {});
    listeners.onMessage({ target: 'worker', type: 'firstRunSeen' }, {}, reply1);
    await Promise.resolve(); await Promise.resolve();
    expect(reply1).toHaveBeenCalledWith({ first: true });

    const reply2 = mock(() => {});
    listeners.onMessage({ target: 'worker', type: 'firstRunSeen' }, {}, reply2);
    await Promise.resolve(); await Promise.resolve();
    expect(reply2).toHaveBeenCalledWith({ first: false });
  });

  test('lookup dispatches through the queue and eventually replies (capped or not)', async () => {
    storageData.consent = false; // deterministic short-circuit inside lookup() itself
    const reply = mock(() => {});
    const handled = listeners.onMessage(
      { target: 'worker', type: 'lookup', extraction: baseExtraction() },
      { origin: ORIGIN },
      reply,
    );
    expect(handled).toBe(true);
    // enqueue() is a real, shared token bucket — poll briefly rather than assume timing.
    for (let i = 0; i < 50 && reply.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(reply).toHaveBeenCalledTimes(1);
    const [result] = reply.mock.calls[0];
    expect(result.render).toBe('none');
    expect(['no_consent', 'rate_capped']).toContain(result.reasons[0]);
  });
});

// --- chrome.runtime.onInstalled listener -----------------------------------------

describe('the onInstalled listener', () => {
  test('stamps updatedAt always, and opens the options page only on a fresh install', async () => {
    await listeners.onInstalled({ reason: 'install' });
    expect(typeof storageData.updatedAt).toBe('number');
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);

    chrome.runtime.openOptionsPage.mockClear();
    await listeners.onInstalled({ reason: 'update' });
    expect(typeof storageData.updatedAt).toBe('number');
    expect(chrome.runtime.openOptionsPage).not.toHaveBeenCalled();
  });
});

// --- chrome.tabs.onUpdated listener -----------------------------------------------

describe('the tabs.onUpdated listener', () => {
  test('forwards a navigation to the content script only when changeInfo.url is present', () => {
    listeners.tabsOnUpdated(7, {});
    expect(sentTabMessages).toHaveLength(0);

    listeners.tabsOnUpdated(7, { url: 'https://warmlydecor.com/products/x' });
    expect(sentTabMessages).toHaveLength(1);
    expect(sentTabMessages[0]).toEqual([7, { target: 'content', type: 'navigated', url: 'https://warmlydecor.com/products/x' }]);
  });

  test('a rejected sendMessage (no listener in the tab) is swallowed, not thrown', () => {
    chrome.tabs.sendMessage = mock(() => Promise.reject(new Error('Receiving end does not exist')));
    expect(() => listeners.tabsOnUpdated(7, { url: 'https://warmlydecor.com/x' })).not.toThrow();
  });
});

// --- enqueue: serialization and fault tolerance -----------------------------------
// enqueue's token bucket (chain/lastStart/hourStamps) is real module-level state with
// no reset hook, by design — it has to survive worker restarts across real requests —
// so these tests only assert properties that hold regardless of what earlier tests
// already pushed through the same queue: that calls run one at a time, in order, and
// that one throwing call does not wedge the ones behind it.
//
// NOTE: the HOURLY_CAP enforcement itself (`hourStamps.filter(...).length >= HOURLY_CAP`)
// was deliberately NOT asserted here. Reproducing it isolated from the rest of enqueue()
// shows the prune line (`hourStamps.splice(0, hourStamps.findIndex(...) + 1 || 0)`)
// discards one live timestamp on every call whenever the oldest entry is still within
// the window — which is the entire first hour of any real run — so hourStamps never
// grows past 1 and the cap is never actually reached. That looks like a pre-existing
// bug in the prune arithmetic; fixing it is out of scope for adding tests, so it is
// flagged here rather than asserted as if it were working.

describe('enqueue', () => {
  test('runs queued calls one at a time, in submission order', async () => {
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    try {
      const order = [];
      const results = await Promise.all([
        w.enqueue(async () => { order.push('start-a'); order.push('end-a'); return 'a'; }),
        w.enqueue(async () => { order.push('start-b'); order.push('end-b'); return 'b'; }),
        w.enqueue(async () => { order.push('start-c'); order.push('end-c'); return 'c'; }),
      ]);
      expect(results).toEqual(['a', 'b', 'c']);
      expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c']);
    } finally {
      globalThis.setTimeout = realTimeout;
    }
  });

  test('a call that throws does not break the queue for the calls behind it', async () => {
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    try {
      const failing = w.enqueue(async () => { throw new Error('boom'); });
      const after = w.enqueue(async () => 'still works');
      await expect(failing).rejects.toThrow('boom');
      expect(await after).toBe('still works');
    } finally {
      globalThis.setTimeout = realTimeout;
    }
  });
});
