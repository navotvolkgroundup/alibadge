// Service worker. Owns every network call and every chrome.* API.
//
// Both AliExpress calls were verified live on 2026-07-26 and need NO cookies and
// NO login. host_permissions is what makes them readable from here — the results
// endpoint reflects Origin in ACAO rather than sending *, so a web page could not
// do this, but an extension worker can.
import {
  decide, isAllowedImageUrl, urlCacheKey, md5, markupPercent, parsePrice, dearestFromSkuMap,
  buildGate, stripAlicdnSize, HASH_MAX_DISTANCE, liveWithin,
} from './lib.js';

const UPLOAD_HOST = 'https://recom-acs.aliexpress.com'; // no MTOP handshake needed
const UPLOAD_API = 'mtop.relationrecommend.AliexpressRecommend.recommend';
const UPLOAD_APPKEY = '24815441';
const UPLOAD_APPID = 21738;
const RESULTS_LOCALE = 'https://www.aliexpress.com';

const SHIP_TO = 'US';      // pinned, disclosed on the receipt so a third party can reproduce
const CURRENCY = 'USD';    // ditto — NOT derived from locale
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Bump to invalidate every existing entry. Entries now hold search RESULTS, not
// verdicts, so this only needs bumping when the result SHAPE changes — never for a
// change to decide().
export const CACHE_V = 'v4';  // v4: results carry a hash distance `d`; v3 entries had no gate
export const CACHE_MAX = 500;     // chrome.storage.local has no LRU and a 10MB quota
export const MIN_GAP_MS = 4000;   // token bucket: concurrency 1 bounds simultaneity, not rate
export const HOURLY_CAP = 120;

// Default ON: silence is this extension's normal state, so a load-unpacked build
// with logging off is indistinguishable from a broken one. Opt out explicitly.
let debug = true;
chrome.storage.local.get('alibadgeDebug').then((r) => (debug = r.alibadgeDebug !== false));
const log = (...a) => debug && console.log('[alibadge]', ...a);
console.log('[alibadge] worker alive');

// Reloading an extension does NOT re-inject content scripts into open tabs: the old
// script keeps running with the old code and its already-computed verdict. That
// produced a receipt carrying a caveat the shipped logic cannot generate, a basis
// string deleted two commits earlier, and yesterday's capture date — all of it real
// output from stale code. Stamp the update time so a stale page can notice.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.storage.local.set({ updatedAt: Date.now() });
  // Ask before uploading anything. On a fresh install that means the options page, not a
  // badge that has already sent a photo to a third party.
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

// --- serial queue + token bucket --------------------------------------------
// A serial queue alone does not limit requests per minute, which is what the
// marketplace's rate limiting actually counts.
let chain = Promise.resolve();
let lastStart = 0;
const hourStamps = [];

export function enqueue(fn) {
  const run = chain.then(async () => {
    const now = Date.now();
    // ONE source of truth. This used to prune with a splice and then count with a
    // separate filter, and the splice deleted a live timestamp every call — so the array
    // never passed length 1 and this cap never fired once. See liveWithin() in lib.js.
    const live = liveWithin(hourStamps, now);
    if (live.length >= HOURLY_CAP) {
      log(`rate capped: ${live.length} calls in the last hour`);
      return { render: 'none', reasons: ['rate_capped'] };
    }
    const wait = Math.max(0, MIN_GAP_MS - (now - lastStart));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    hourStamps.length = 0;
    hourStamps.push(...live, lastStart);
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

// --- cache -------------------------------------------------------------------
// Primary key is the SHA-256 of the image BYTES: that dedups the same supplier
// photo across every store selling it, which is the only reason a cache reduces
// upload volume. Hashing is local CPU (free); the upload is the scarce resource.
async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function cacheGet(keys) {
  const got = await chrome.storage.local.get(keys.map((k) => `c:${CACHE_V}:${k}`));
  for (const k of keys) {
    const hit = got[`c:${CACHE_V}:${k}`];
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  }
  return null;
}

export async function cachePut(keys, v) {
  const rec = { t: Date.now(), v };
  const put = {};
  for (const k of keys) put[`c:${CACHE_V}:${k}`] = rec;
  await chrome.storage.local.set(put);
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith('c:'));
  if (entries.length > CACHE_MAX) {
    entries.sort((a, b) => a[1].t - b[1].t);
    await chrome.storage.local.remove(entries.slice(0, entries.length - CACHE_MAX).map(([k]) => k));
  }
}

// --- AliExpress: upload ------------------------------------------------------
// `type:"POST"` in AliExpress's own JS client maps to a real POST here. The
// default jsonp/GET transport puts the payload in the query string and caps it
// near 8KB of base64, which silently degrades the image and wrecks match quality.
// MTOP handshake. The first call returns FAIL_SYS_TOKEN_EMPTY (or _EXPIRED, once the
// cookie has aged) and sets a fresh _m_h5_tk;
// the token is the part before the "_". `recom-acs` does NOT skip this — verified
// against a live call, contrary to an earlier note in the design doc. Reading the
// cookie is why the `cookies` permission is required after all.
export async function tokenFor(host) {
  try {
    const c = await chrome.cookies.get({ url: host, name: '_m_h5_tk' });
    return c && c.value ? c.value.split('_')[0] : null;
  } catch {
    return null;
  }
}
const mtopToken = () => tokenFor(UPLOAD_HOST);

async function mtopCall(data, token) {
  const t = Date.now();
  const sign = md5([token || '', t, UPLOAD_APPKEY, data].join('&'));
  const qs = new URLSearchParams({
    jsv: '2.5.1', appKey: UPLOAD_APPKEY, t: String(t), sign,
    api: UPLOAD_API, v: '1.0', type: 'originaljson', dataType: 'json', timeout: '50000',
  });
  const res = await fetch(`${UPLOAD_HOST}/h5/${UPLOAD_API.toLowerCase()}/1.0/?${qs}`, {
    method: 'POST',
    credentials: 'include', // let the browser hold _m_h5_tk across the handshake
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(data),
  });
  return res.json().catch(() => null);
}

export async function uploadImage(b64, currency) {
  const params = {
    appId: UPLOAD_APPID,
    isNewImageSearch: true,
    osf: 'pc_web_image_search',
    page: 1,
    pageSize: 60,
    clientType: 'pc',
    searchBizScene: 'imageSearch',
    subScenario: 'imageUpload',
    contentType: 'imageUpload',
    image_base64: b64,
    shpt_co: SHIP_TO,
    // Follow the STORE's presentment currency: correctness beats a pinned
    // constant, and whatever was used is stamped on the receipt, so it stays
    // reproducible by a third party either way.
    _currency: currency || CURRENCY,
    sortType: 'default',
    sortOrder: 'default',
    timeout: 50000,
    platform: 'pc',
  };
  const data = JSON.stringify({ appId: UPLOAD_APPID, params: JSON.stringify(params) });

  let j = await mtopCall(data, await mtopToken());
  // EXPIRED as well as EMPTY: measured a live `FAIL_SYS_TOKEN_EXOIRED` (their typo) that
  // fell through this check and cost the item an upload with no retry.
  if (j && /TOKEN_(EMPTY|EXPIRED|EXOIRED)/.test(String(j.ret))) {
    // The failed call just set a fresh cookie; re-read it and sign again.
    j = await mtopCall(data, await mtopToken());
  }
  const fileId = j && j.data && j.data.fileId;
  log('upload', j && j.ret, fileId ? 'ok' : 'no fileId');
  return fileId || null;
}

// --- AliExpress: results in the STORE's currency ------------------------------
// The results endpoint returns whatever currency the caller's geo implies (ILS from
// Israel), and decide() rightly refuses to compare that against a USD store price.
//
// MEASURED 2026-07-27, same fileId, back to back:
//   with aep_usuc_f c_tp=USD  -> 60 items, currencies [USD], first "US $94.73"
//   no cookie (control)       -> 60 items, currencies [ILS], first "\u20aa 21.25"
//
// So one cookie does the whole job. This replaces mtop.aliexpress.pdp.pc.query,
// which was the previous plan and is a dead end twice over: it is punished on the
// FIRST call from outside a browser (FAIL_SYS_USER_VALIDATE), and it needed its own
// appKey and handshake to re-price candidates one at a time. A cookie costs nothing
// and fixes every candidate at once.
//
// region stays US to match the pinned shpt_co, which the receipt discloses.
export const AEP_COOKIE = 'aep_usuc_f';

// --- AliExpress: the winner's DEAREST variant --------------------------------
// The results payload carries only salePrice.minPrice — dumped across 60 items, there
// is no max and no range. So the compared figure is the listing's CHEAPEST variant and
// every markup is an upper bound.
//
// pdp.pc.query returns the full sku price map. It is punished on the first call from
// bun, which is why the earlier top-3 re-price was deleted; from inside the extension
// it may not be. ONE call, for the winner only, so a punish costs one request rather
// than three and the badge degrades to the bound instead of disappearing.
const PDP_API = 'mtop.aliexpress.pdp.pc.query';
const PDP_APPKEY = '12574478';
const PDP_HOST = 'https://acs.aliexpress.com';

async function pdpCall(data, token) {
  const t = Date.now();
  const sign = md5([token || '', t, PDP_APPKEY, data].join('&'));
  const qs = new URLSearchParams({
    jsv: '2.5.1', appKey: PDP_APPKEY, t: String(t), sign,
    api: PDP_API, v: '1.0', type: 'originaljson', dataType: 'json', timeout: '15000',
  });
  const res = await fetch(`${PDP_HOST}/h5/${PDP_API}/1.0/?${qs}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(data),
  });
  return res.json().catch(() => null);
}

// Returns the DEAREST variant price in `currency`, or null. Null is a normal outcome
// (punish, shape change, unlisted item) and must leave the caller with the bound.
//
// MEASURED from inside the extension: SUCCESS, ~74KB, and no handshake needed because
// the cookie is already present. The bun-side FAIL_SYS_USER_VALIDATE was about the
// client, not the endpoint.
export function findKey(o, name, d = 0) {
  if (!o || typeof o !== 'object' || d > 8) return null;
  if (o[name]) return o[name];
  for (const v of Object.values(o)) {
    const r = findKey(v, name, d + 1);
    if (r) return r;
  }
  return null;
}

export async function pdpDearest(productId, currency) {
  const data = JSON.stringify({
    productId: String(productId), _currency: currency || CURRENCY,
    country: SHIP_TO, locale: 'en_US', pdp_ext_f: '{}',
  });
  let j = await pdpCall(data, await tokenFor(PDP_HOST));
  if (j && /TOKEN_(EMPTY|EXPIRED|EXOIRED)/.test(String(j.ret))) j = await pdpCall(data, await tokenFor(PDP_HOST));
  if (!j || /PUNISH|VALIDATE|RGV587/i.test(String(j.ret))) {
    log('pdp:', j ? String(j.ret) : 'no response');
    return null;
  }
  // Located by name rather than by path: the envelope is data.result.<...> and has
  // moved before. The PARSING lives in lib.js with tests against a real entry —
  // salePriceLocal ("$9.80|9|80") and originalPrice are both traps.
  const dearest = dearestFromSkuMap(findKey(j, 'skuPriceInfoMap'), currency);
  if (dearest == null) log('pdp: no usable skuPriceInfoMap — ret', String(j.ret));
  return dearest;
}

// Exposed for a one-line check from the service-worker console. Returns a DIAGNOSTIC
// object, not just the price: a bare null cannot distinguish a punish from a request
// the server accepted but did not understand, and those need opposite fixes.
//   await self.__alibadgePdp('32930388619', 'USD')
self.__alibadgePdp = async (productId, currency = 'USD') => {
  const data = JSON.stringify({
    productId: String(productId), _currency: currency || CURRENCY,
    country: SHIP_TO, locale: 'en_US', pdp_ext_f: '{}',
  });
  let j = await pdpCall(data, await tokenFor(PDP_HOST));
  const firstRet = j && String(j.ret);
  if (j && String(j.ret).includes('TOKEN_EMPTY')) j = await pdpCall(data, await tokenFor(PDP_HOST));
  const raw = JSON.stringify(j || {});
  const nums = [];
  raw.replace(/"(?:formattedPrice|minPrice|maxPrice|skuVal|actSkuCalPrice|skuCalPrice)"\s*:\s*"?([\d.,]+)"?/g,
    (m, n) => { const v = parseFloat(String(n).replace(/,/g, '')); if (v > 0 && v < 1e6) nums.push(v); return m; });
  return {
    firstRet,                                   // TOKEN_EMPTY on a healthy handshake
    ret: j && j.ret,                            // SUCCESS, or FAIL_SYS_USER_VALIDATE = punished
    punished: /PUNISH|VALIDATE|RGV587/i.test(String(j && j.ret)),
    bytes: raw.length,                          // ~20 chars means an empty envelope
    topKeys: j && j.data ? Object.keys(j.data).slice(0, 25) : null,
    priceFieldsFound: nums.length,
    dearest: nums.length ? Math.max(...nums) : null,
    // MEASURED: the extension gets SUCCESS and a 74KB payload, so the request is fine
    // and the guessed field names were the problem. Report the names that actually
    // exist with a sample value each, instead of guessing a third time.
    priceKeys: (() => {
      const seen = {};
      raw.replace(/"([A-Za-z_]*(?:[Pp]rice|[Aa]mount|[Vv]alue|[Cc]ent)[A-Za-z_]*)"\s*:\s*("[^"]{0,24}"|[\d.]+)/g,
        (m, k, v) => { if (!(k in seen)) seen[k] = v; return m; });
      return seen;
    })(),
    // Where the sku list lives, if it is findable by name.
    skuKeys: [...new Set((raw.match(/"[A-Za-z_]*[Ss]ku[A-Za-z_]*"/g) || []))].slice(0, 30),
    // skuPriceInfoMap EXISTS (measured) — so dump one entry verbatim before writing a
    // parser against it. The payload mixes units and cents (salePriceString "$6.76"
    // next to originalPriceCent 661), and picking the wrong one is a 100x error on the
    // exact number that accuses a merchant. Not guessing this one.
    ...(() => {
      const find = (o, name, d = 0) => {
        if (!o || typeof o !== 'object' || d > 8) return null;
        if (o[name]) return o[name];
        for (const v of Object.values(o)) { const r = find(v, name, d + 1); if (r) return r; }
        return null;
      };
      const map = find(j, 'skuPriceInfoMap');
      const keys = map ? Object.keys(map) : [];
      return {
        skuCount: keys.length,
        skuSample: map && keys.length ? JSON.stringify(map[keys[0]]).slice(0, 700) : null,
        // The spread across variants, straight from the payload, so the max is checkable
        // by eye against whatever the parser ends up returning.
        allSalePriceStrings: [...new Set((raw.match(/"salePriceString"\s*:\s*"([^"]+)"/g) || [])
          .map((x) => x.split('"')[3]))].slice(0, 30),
      };
    })(),
    head: raw.slice(0, 600),
  };
};

// The cookie is the USER's — it drives the currency they see on aliexpress.com. Set
// it for the search, then put back exactly what was there, including absent.
export async function withStoreCurrency(currency, fn) {
  const url = RESULTS_LOCALE + '/';
  let prior = null;
  try {
    prior = await chrome.cookies.get({ url, name: AEP_COOKIE });
  } catch {}
  const want = `site=glo&c_tp=${currency || CURRENCY}&region=${SHIP_TO}&b_locale=en_US`;
  const domain = '.aliexpress.com';
  try {
    await chrome.cookies.set({ url, name: AEP_COOKIE, value: want, domain, path: '/' });
    return await fn();
  } finally {
    try {
      if (prior && prior.value) {
        await chrome.cookies.set({ url, name: AEP_COOKIE, value: prior.value, domain, path: '/' });
      } else {
        await chrome.cookies.remove({ url, name: AEP_COOKIE });
      }
    } catch (e) {
      log('could not restore', AEP_COOKIE, String(e).slice(0, 60));
    }
  }
}

export async function fetchResults(fileId, attempt = 1) {
  const res = await fetch(`${RESULTS_LOCALE}/fn/search-pc/index`, {
    method: 'POST',
    // include, NOT omit: the currency comes from the aep_usuc_f cookie set by
    // withStoreCurrency(), and omitting credentials silently reverts to geo currency.
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isNewImageSearch: 'y', filename: fileId, pageVersion: '', page: 1 }),
  });
  if (!res.ok) {
    // 403 here means the app-layer Origin check rejected chrome-extension:// —
    // measured: same request returns 60 items with an aliexpress Origin and 403
    // with the extension's. rules.json rewrites it via declarativeNetRequest, so
    // a 403 reaching this line means that rule is not applying.
    log(`results: HTTP ${res.status}${res.status === 403 ? ' — Origin rewrite not applied?' : ''}`);
    const e = new Error('http_' + res.status);
    e.httpStatus = res.status;
    throw e;
  }
  const text = await res.text();
  // The wall returns HTTP 200 with an HTML redirect to _____tmd_____/punish, so
  // status alone never reveals it. Measured: this endpoint rate-punishes
  // non-browser clients. Whether Chrome's own network stack fares better is the
  // open question — surface it as a distinct reason so debug mode can tell.
  if (/_____tmd_____|x5secdata|RGV587/.test(text)) {
    log('results: PUNISHED');
    const e = new Error('punish');
    e.punished = true;
    throw e;
  }
  let j = null;
  try { j = JSON.parse(text); } catch {}
  const items = j?.data?.data?.root?.fields?.mods?.itemList?.content;
  if (!Array.isArray(items) || !items.length) {
    // A freshly minted fileId is not immediately visible to the search index —
    // observed repeatedly: an empty item list right after upload that populates a
    // couple of seconds later. Retry before giving up, or the badge silently loses
    // to a race it would have won.
    log(`results: empty (attempt ${attempt}, ${text.length}b, parsed=${!!j})`);
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 1200 * attempt));
      return fetchResults(fileId, attempt + 1);
    }
    return [];
  }
  log(`results: ${items.length} items (attempt ${attempt})`);
  return items.map((it) => ({
    productId: it.productId,
    title: it.title?.displayTitle || '',
    image: it.image?.imgUrl ? 'https:' + it.image.imgUrl.replace(/^https?:/, '') : null,
    // salePrice is what a buyer pays. originalPrice is the struck-through figure and
    // would inflate the markup — the same trap compare_at_price sets store-side.
    price: it.prices?.salePrice?.minPrice ?? it.prices?.salePrice?.formattedPrice ?? null,
    currency: it.prices?.salePrice?.currencyCode || null,
    sold: it.trade?.tradeDesc || null,
    url: it.productId ? `https://www.aliexpress.com/item/${it.productId}.html` : null,
  })).filter((r) => r.productId);
}

// --- thumbnails for the receipt ----------------------------------------------
// The receipt is drawn on a canvas in the content script, and toBlob() throws on a
// tainted canvas. Measured: ae01.alicdn.com serves images with NO
// access-control-allow-origin in a browser context, and aliexpress-media.com is
// blocked outright by common ad blockers. So the worker fetches them (no CORS
// applies to host_permissions) and hands back data URLs, which never taint.
function toBase64(buf) {
  const b = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(bin);
}

// MEASURED: the upload silently returns no fileId on large payloads. Store hero images
// are routinely PNGs of 1-7MB — Stanley 7.0MB, Otterbox 1.9MB, Anker 870KB all failed;
// Spigen's 70KB JPEG succeeded. That cost 9 of 16 hard negatives in the labelled run,
// i.e. most of the bucket the primary success criterion depends on, and it looked like
// a property of those stores rather than a payload limit.
//
// So downscale to a bounded JPEG before uploading. Full resolution is only worth
// keeping while it fits: the design doc's warning was about the 8KB jsonp cap wrecking
// match quality, and 1200px is nowhere near that.
const UPLOAD_MAX_PX = 1200;
export const UPLOAD_MAX_BYTES = 400 * 1024;

export async function encodeForUpload(buf) {
  if (buf.byteLength <= UPLOAD_MAX_BYTES) return { b64: toBase64(buf), resized: false };
  try {
    const bmp = await createImageBitmap(new Blob([buf]));
    const scale = Math.min(1, UPLOAD_MAX_PX / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const dims = `${bmp.width}x${bmp.height} -> ${c.width}x${c.height}`;
    bmp.close();
    let blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    // One retry at lower quality; a 7MB PNG of a flat product shot can still exceed
    // the cap after a size-only downscale.
    if (blob.size > UPLOAD_MAX_BYTES) blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    log(`upload image ${Math.round(buf.byteLength / 1024)}KB -> ${Math.round(blob.size / 1024)}KB (${dims})`);
    return { b64: toBase64(await blob.arrayBuffer()), resized: true };
  } catch (e) {
    // Better to try the original than to give up: it may still be under the real cap.
    log('downscale failed, uploading original:', String(e).slice(0, 60));
    return { b64: toBase64(buf), resized: false };
  }
}

// dHash: 9x8 greyscale, one bit per horizontal gradient. Scale- and re-encode-invariant,
// which is exactly what a store does to a supplier photo before publishing it.
export async function dhashOf(blobOrBuf) {
  try {
    const bmp = await createImageBitmap(blobOrBuf instanceof Blob ? blobOrBuf : new Blob([blobOrBuf]));
    const c = new OffscreenCanvas(9, 8);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, 9, 8);
    bmp.close();
    const { data } = g.getImageData(0, 0, 9, 8);
    // Rec. 601 luma, the same weighting Pillow's "L" mode uses — the offline
    // measurement that set HASH_MAX_DISTANCE was taken with Pillow.
    const lum = [];
    for (let i = 0; i < data.length; i += 4) {
      lum.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
    let bits = '';
    for (let r = 0; r < 8; r++) {
      for (let col = 0; col < 8; col++) bits += lum[r * 9 + col] < lum[r * 9 + col + 1] ? '1' : '0';
    }
    return bits;
  } catch (e) {
    log('dhash failed', String(e).slice(0, 60));
    return null;
  }
}

// Hash the top candidates so decide() can tell "the same photograph" from "the same
// category". Bounded: each fetch is a small CDN image, but 60 would be absurd and the
// answer lives at the top of the ranking.
// 16, not 8: recall measured 2 of 8 on the labelled set, and the cheapest honest lever
// is looking further down the ranking for a photo match. Each fetch is a small CDN
// image. Most misses are genuine absence of reuse (distances 21-30), so do not expect
// much — but it costs little and it is the only recall lever that adds no risk.
const GATE_CANDIDATES = 16;

export async function gateFor(storeBuf, results) {
  const storeHash = await dhashOf(storeBuf);
  if (!storeHash) return null;
  const head = results.slice(0, GATE_CANDIDATES);
  const hashed = await Promise.all(head.map(async (item) => {
    if (!item.image) return { item, hash: null };
    try {
      // stripAlicdnSize: a padded 220px thumbnail scores far from a full-size store
      // photo even when the two are the same image.
      // Ad blockers routinely block aliexpress-media.com, and with the gate failing
      // closed that turns into silence on every page. The same object is served from
      // alicdn under the same path, so try both hosts before giving up.
      const primary = stripAlicdnSize(item.image);
      const alt = primary.replace(/^https?:\/\/[^/]*aliexpress-media\.com\//, 'https://ae01.alicdn.com/');
      for (const url of alt !== primary ? [primary, alt] : [primary]) {
        try {
          const res = await fetch(url, { credentials: 'omit' });
          if (!res.ok) continue;
          const hash = await dhashOf(await res.blob());
          if (hash) return { item, hash };
        } catch { /* try the next host */ }
      }
      return { item, hash: null };
    } catch {
      return { item, hash: null };
    }
  }));
  const gate = buildGate(storeHash, hashed);
  const passing = gate.filter((x) => x.passes);
  log(`gate: ${passing.length}/${gate.length} within ${HASH_MAX_DISTANCE} — ` +
    `distances ${gate.map((x) => (x.distance === Infinity ? '-' : x.distance)).join(',')}`);
  // Candidates beyond the hashed head keep their rank-based place behind the gate, but
  // only if nothing closer passed; pickWinner() already prefers the smallest distance.
  return gate;
}

export async function thumb(url, px = 260) {
  if (!url) return null;
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const s = Math.min(1, px / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    return 'data:image/jpeg;base64,' + toBase64(await blob.arrayBuffer());
  } catch (e) {
    log('thumb failed', String(e).slice(0, 80));
    return null;
  }
}

// --- pipeline ----------------------------------------------------------------

export async function lookup(extraction, pageOrigin) {
  // Nothing leaves the browser before the user has agreed to it. This extension uploads
  // the product photo of every page it runs on to Alibaba infrastructure, and doing that
  // silently on someone else's browsing is not defensible however useful the result is.
  // Set in options.html; the first run opens it.
  const { consent } = await chrome.storage.local.get('consent');
  if (consent !== true) return { render: 'none', reasons: ['no_consent'] };

  const urlKey = urlCacheKey(extraction.url);
  const early = urlKey ? await cacheGet([urlKey]) : null;
  if (early) { log('cache hit (url)'); return judge(extraction, early); }

  if (!isAllowedImageUrl(extraction.image, pageOrigin)) {
    return { render: 'none', reasons: ['image_url_disallowed'] };
  }

  const imgRes = await fetch(extraction.image, { credentials: 'omit' });
  if (!imgRes.ok) return { render: 'none', reasons: ['image_fetch_failed'] };
  const buf = await imgRes.arrayBuffer();

  const byteKey = await sha256(buf);
  const hit = await cacheGet([byteKey]);
  if (hit) { log('cache hit (bytes)'); return judge(extraction, hit); }

  const { b64 } = await encodeForUpload(buf);

  const fileId = await uploadImage(b64, extraction.currency);
  // Nothing renders before a fileId exists: it is both the evidence that the
  // search ran and the only thing a results link can be built from.
  if (!fileId) return { render: 'none', reasons: ['upload_failed'] };

  let results;
  try {
    // Wrapped so every candidate comes back already priced in the store's currency.
    // Nothing downstream converts anything: decide() compares like with like or
    // refuses, and there is no FX rate anywhere in this extension.
    results = await withStoreCurrency(extraction.currency, () => fetchResults(fileId));
  } catch (e) {
    if (e && (e.punished || e.httpStatus)) {
      // A fileId exists, so the search DID run — degrade to the link rather than
      // going silent, which is the whole point of the link-only state.
      return {
        render: 'link-only',
        reasons: [e.punished ? 'punished' : 'results_http_' + e.httpStatus],
        searchUrl: `https://www.aliexpress.com/w/wholesale-.html?isNewImageSearch=y&filename=${encodeURIComponent(fileId)}`,
      };
    }
    throw e;
  }
  // Cache the SEARCH, not the verdict — see judge(). Empty results are the one
  // transient case that reaches here (every other failure returned early), and
  // caching those turned one bad minute into a week of silence.
  // Hash-gate BEFORE caching, and store the DISTANCES rather than pass/fail, so a cache
  // hit is still gated and a threshold change takes effect without re-fetching images.
  if (results.length) {
    const gate = await gateFor(buf, results);
    const byId = new Map((gate || []).map((x) => [x.item.productId, x.distance]));
    // null, never Infinity: Infinity becomes null through JSON anyway, and writing the
    // sentinel explicitly keeps in-memory and cached behaviour identical.
    results = results.map((r) => {
      const d = byId.get(r.productId);
      return { ...r, d: Number.isFinite(d) ? d : null };
    });
    if (!gate) log('gate: store image could not be hashed — nothing can pass');
  }

  // Upgrade the WINNER's price to its dearest variant, once, before caching — so the
  // corrected number is what gets stored and a cache hit never re-issues the call.
  // Done here rather than in judge() for exactly that reason: judge() runs on every
  // cached page view, and a per-view pdp call multiplies punish risk for nothing.
  if (results.length) {
    const provisional = decide(extraction, results, gateFromStored(results));
    if (provisional.winner) {
      const dearest = await pdpDearest(provisional.winner.productId, extraction.currency);
      const current = parsePrice(provisional.winner.price);
      // Sanity band, not just "bigger". The scan takes a max over every price-shaped
      // field in an undocumented payload, so a bundle or coupon figure could ride in.
      // A variant of the SAME listing within 50x of the cheapest is plausible; beyond
      // that it is probably not a variant, and quietly deflating the ratio would hide
      // a real dropshipper rather than protect anyone.
      const plausible = dearest != null && current != null
        && dearest >= current && dearest <= current * 50;
      if (dearest != null && !plausible) log(`pdp: rejected ${dearest} against ${current} — out of band`);
      if (plausible) {
        const id = provisional.winner.productId;
        results = results.map((r) => (r.productId === id
          ? { ...r, price: dearest, currency: extraction.currency, basis: 'dearest' }
          : r));
        log(`pdp: winner ${id} ${current} -> ${dearest} ${extraction.currency} (dearest variant)`);
      } else {
        log('pdp: no dearest price, markup stays an upper bound');
      }
    }
  }

  if (results.length) {
    await cachePut(urlKey ? [byteKey, urlKey] : [byteKey], { fileId, results });
  } else {
    log('not caching: no results');
  }
  return judge(extraction, { fileId, results });
}

// Everything downstream of the network. Deliberately OUTSIDE the cache: twice now
// a decision-logic fix has been invisible because a stale verdict was replayed
// from storage, and bumping CACHE_V each time only defers the next occurrence.
// Re-deciding on every read costs one function call and makes that class impossible.
// ALWAYS returns a gate. Never null.
//
// It used to return null when no candidate carried a distance, which silently fell back
// to AliExpress's own rank — ungated — in exactly the two situations where the gate is
// most needed:
//   1. The STORE image could not be hashed at all.
//   2. Every candidate image fetch failed. Note Infinity does not survive the cache:
//      JSON.stringify(Infinity) is "null", so a cache round-trip erased every distance.
// A blocked CDN is enough to trigger (2) — the candidate images come from
// aliexpress-media.com, which ad blockers routinely block.
//
// MEASURED consequence: i-cell.co.il rendered +570% against a licensed Otterbox whose
// closest gallery image is 21 bits away. The gate was correct and simply absent.
//
// So no distance means no pass. The gate is mandatory, and its absence is silence.
export function gateFromStored(results) {
  return results.map((item) => ({
    item,
    distance: item.d == null ? Infinity : item.d,
    passes: item.d != null && item.d <= HASH_MAX_DISTANCE,
  }));
}

export async function judge(extraction, found) {
  const { fileId, results } = found;

  // The gate rank alone could not provide. MEASURED: ungated, the labelled run produced
  // 7 badges of which 4 were false accusations against Spigen; gated at distance 10, 1
  // badge and 0 false. It also rejects the winner collapse — three different cutlery
  // sets that all matched one listing whose photo sits 31-36 bits from theirs.
  const verdict = decide(extraction, results, gateFromStored(results));

  const out = {
    render: verdict.render,
    reasons: verdict.reasons,
    note: verdict.note || null,
    // Derived, never asserted. A hardcoded basis string is what let the receipt claim
    // 'dearest variant' for a whole period after the code stopped doing that.
    priceBasis: verdict.winner && verdict.winner.basis === 'dearest'
      ? 'matched listing, dearest variant'
      : 'matched listing, cheapest variant — markup is an upper bound',
    searchUrl: `https://www.aliexpress.com/w/wholesale-.html?isNewImageSearch=y&filename=${encodeURIComponent(fileId)}`,
  };
  if (verdict.winner) {
    const ali = parsePrice(verdict.winner.price);
    // Fetched here, not in the page: see thumb().
    const [storeThumb, aliThumb] = await Promise.all([
      thumb(extraction.image), thumb(verdict.winner.image),
    ]);
    Object.assign(out, {
      storeThumb,
      aliThumb,
      aliPrice: ali,
      aliCurrency: verdict.winner.currency || extraction.currency || CURRENCY,
      aliUrl: verdict.winner.url,
      aliTitle: verdict.winner.title,
      aliImage: verdict.winner.image,
      sold: verdict.winner.sold,
      markup: ali ? markupPercent(extraction.price, ali) : null,
      shipTo: SHIP_TO,
      capturedAt: new Date().toISOString().slice(0, 10),
    });
  }
  log('verdict', out.render, out.reasons);
  return out;
}

// --- messaging ---------------------------------------------------------------
// Every message carries a `target`, because chrome.runtime.sendMessage broadcasts
// to the whole extension origin and any other listener would also try to reply.
// --- labelled-set measurement ------------------------------------------------
// Premise 2 at scale has to be measured HERE. From bun, /fn/search-pc/index worked
// for three items then rate-punished every retry, and pdp.pc.query is punished on
// the first call (FAIL_SYS_USER_VALIDATE) — so a non-browser harness cannot produce
// the number. Inside a loaded extension both calls work; that is the whole reason
// this lives in the worker instead of in labelset/run.js.
//
// From the extension's service-worker console:
//   await self.__alibadgeLabelset()          // resumes; re-run until COMPLETE
//   await self.__alibadgeLabelset(null, true) // start over, clearing the result cache
//   await self.__alibadgeLabelsetDump()      // print stored rows without running
//
// Goes through the same enqueue() and the same lookup() a real page does, so the
// measurement grades shipped behaviour rather than a parallel implementation.
//
// If the console says "No SW", Chrome has killed the idle worker. Load any Shopify
// product page to wake it, then re-open the service-worker inspector.
// MV3 kills an idle worker, so this run must survive a restart: every row is written
// to chrome.storage as it completes, and a re-run resumes where it stopped instead of
// re-spending 40 uploads. Rows whose reason means "no comparison happened" are retried.
const LS_KEY = 'labelsetRows';
const LS_RETRY = /^(punished|no_results|upload_failed|image_fetch_failed|harness_error|worker_error|rate_capped)/;

self.__alibadgeLabelset = async (itemsUrl, fresh = false) => {
  const url = itemsUrl || chrome.runtime.getURL('labelset/set.json');
  let items;
  try {
    items = await (await fetch(url)).json();
  } catch (e) {
    console.error(`[labelset] could not load the set from ${url}: ${e}`);
    return null;
  }

  const store = await chrome.storage.local.get(LS_KEY);
  const rows = new Map((store[LS_KEY] || []).map((r) => [r.id, r]));
  if (fresh) {
    // Only on request: entries predating the currency cookie hold ILS candidates and
    // entries predating pdp carry no dearest flag, both of which would be scored as
    // current behaviour. Costs a full re-search of everything.
    const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('c:'));
    await chrome.storage.local.remove(keys);
    rows.clear();
    console.log(`[labelset] fresh: cleared ${keys.length} cache entries and all prior rows`);
  }

  const todo = items.filter((i) => {
    const r = rows.get(i.id);
    return !r || (r.reasons || []).some((x) => LS_RETRY.test(x));
  });
  console.log(`[labelset] ${items.length} items · done ${items.length - todo.length} · pending ${todo.length}`);

  for (const [n, it] of todo.entries()) {
    const extraction = {
      // The REAL product path. A constant '/products/x' gave every product on a host the
      // same urlCacheKey, so items 2..n answered from item 1's cached results AND its
      // gate distances — three warmlydecor sets and two Misen lids inherited verdicts
      // they were never measured for.
      url: `https://${it.host}/products/${it.id.split('/').slice(1).join('/')}`,
      host: it.host, title: it.title,
      vendor: it.vendor, price: it.price, currency: it.currency, image: it.image,
    };
    let v;
    try {
      v = await enqueue(() => lookup(extraction, `https://${it.host}`));
    } catch (e) {
      v = { render: 'none', reasons: ['harness_error'], error: String(e).slice(0, 80) };
    }
    rows.set(it.id, {
      id: it.id, bucket: it.bucket, fp: it.fp, host: it.host, title: it.title,
      vendor: it.vendor, price: it.price, currency: it.currency,
      render: v.render, reasons: v.reasons || [], note: v.note || null,
      aliPrice: v.aliPrice ?? null, aliCurrency: v.aliCurrency ?? null,
      aliTitle: v.aliTitle ?? null, aliUrl: v.aliUrl ?? null, markup: v.markup ?? null,
      // Both image URLs, so a perceptual-hash experiment can run offline with no
      // further AliExpress calls — the next question is whether hash distance
      // separates reused supplier photos from a brand's own photography.
      storeImage: it.image, aliImage: v.aliImage ?? null,
      // Whether the number is a measurement or an upper bound.
      priceBasis: v.priceBasis ?? null,
    });
    // After EVERY item, so a worker restart costs one item and not the run.
    await chrome.storage.local.set({ [LS_KEY]: [...rows.values()] });
    console.log(`[labelset] ${n + 1}/${todo.length} ${it.bucket} ${v.render} ` +
      `${(v.reasons || []).join(',')} ${it.id}`);
  }

  const all = [...rows.values()];
  const pending = items.filter((i) => {
    const r = rows.get(i.id);
    return !r || (r.reasons || []).some((x) => LS_RETRY.test(x));
  }).length;
  console.log(`[labelset] ${all.length}/${items.length} measured, ${pending} still pending` +
    (pending ? ' — re-run to continue' : ' — COMPLETE'));
  console.log('[labelset] JSON:\n' + JSON.stringify(all));
  return { measured: all.length, pending };
};

// Print the accumulated rows without running anything, e.g. after a worker restart.
self.__alibadgeLabelsetDump = async () => {
  const store = await chrome.storage.local.get(LS_KEY);
  const all = store[LS_KEY] || [];
  console.log(`[labelset] ${all.length} rows stored`);
  console.log(JSON.stringify(all));
  return all.length;
};

// Run the whole pipeline for one product URL from the service-worker console, so a
// silent badge can be diagnosed without hunting the page console for a log line:
//   await self.__alibadgeProbeUrl('https://warmlydecor.com/products/royal-vintage-cutlery-set')
// Rebuilds the extraction from the page the way content.js does (og:price first, then
// products.js), then calls the REAL lookup so the reasons are the shipped ones.
self.__alibadgeProbeUrl = async (url, force = false) => {
  const u = new URL(url);
  const html = await (await fetch(url)).text();
  const jsonUrl = u.origin + u.pathname.replace(/\/$/, '') + '.js';
  const p = await (await fetch(jsonUrl)).json().catch(() => null);
  if (!p) return { error: 'products.js not parseable at ' + jsonUrl };

  const meta = (prop) => {
    const m = new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*content=["']([^"']+)`).exec(html)
      || new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${prop}["']`).exec(html);
    return m ? m[1] : null;
  };
  const ogAmt = parseFloat(String(meta('og:price:amount')).replace(/,/g, ''));
  const price = Number.isFinite(ogAmt) && ogAmt > 0 ? ogAmt : parseInt(p.variants[0].price, 10) / 100;
  const currency = meta('og:price:currency') || p.currency || null;
  const img = String((p.images || [])[0] || '');

  const extraction = {
    url, host: u.hostname, title: p.title || '', vendor: p.vendor || '',
    price, currency, image: img.startsWith('//') ? 'https:' + img : img,
  };
  // force skips the cache. Needed because entries written before the currency cookie
  // hold ILS-priced candidates, and before the pdp lookup hold no dearest flag — so a
  // cache hit can answer with numbers the current code would never produce.
  if (force) {
    // ALL of them, not just the url-keyed ones. Filtering by url key left the
    // sha256-of-image-bytes entry in place, so the "fresh" run logged
    // `cache hit (bytes)` and answered from the same stale results — including a
    // priceBasis of 'cheapest variant', which only happens when pdp never ran.
    const keys = Object.keys(await chrome.storage.local.get(null)).filter((x) => x.startsWith('c:'));
    await chrome.storage.local.remove(keys);
    log(`probe: cleared ${keys.length} cache entries (all)`);
  }
  const verdict = await enqueue(() => lookup(extraction, u.origin));
  return {
    extraction,
    render: verdict.render,
    reasons: verdict.reasons,
    note: verdict.note || null,
    aliPrice: verdict.aliPrice ?? null,
    aliCurrency: verdict.aliCurrency ?? null,
    aliTitle: verdict.aliTitle ?? null,
    markup: verdict.markup ?? null,
    priceBasis: verdict.priceBasis ?? null,
  };
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target !== 'worker') return false;

  if (msg.type === 'lookup') {
    const origin = sender.origin || (sender.url ? new URL(sender.url).origin : '');
    enqueue(() => lookup(msg.extraction, origin))
      .then(reply)
      .catch((e) => reply({ render: 'none', reasons: ['worker_error'], error: String(e) }));
    return true; // async
  }

  if (msg.type === 'isMuted') {
    chrome.storage.local.get('muted').then((r) => reply({ muted: !!(r.muted || {})[msg.host] }));
    return true;
  }

  if (msg.type === 'mute') {
    chrome.storage.local.get('muted').then((r) => {
      const muted = r.muted || {};
      muted[msg.host] = true;
      chrome.storage.local.set({ muted }).then(() => reply({ ok: true }));
    });
    return true;
  }

  if (msg.type === 'firstRunSeen') {
    chrome.storage.local.get('firstRunSeen').then((r) => {
      if (!r.firstRunSeen) chrome.storage.local.set({ firstRunSeen: true });
      reply({ first: !r.firstRunSeen });
    });
    return true;
  }

  return false;
});

// Navigation detection lives here, not in a history patch: a content script's
// isolated world has its own `history`, so patching it never intercepts the page,
// and replaceState (which Shopify variant switching uses) never fires popstate.
// changeInfo.url is populated because host_permissions covers the tab — the
// `tabs` permission is NOT required. Do not add it.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  chrome.tabs.sendMessage(tabId, { target: 'content', type: 'navigated', url: changeInfo.url }).catch(() => {});
});
