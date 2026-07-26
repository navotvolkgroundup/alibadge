// Service worker. Owns every network call and every chrome.* API.
//
// Both AliExpress calls were verified live on 2026-07-26 and need NO cookies and
// NO login. host_permissions is what makes them readable from here — the results
// endpoint reflects Origin in ACAO rather than sending *, so a web page could not
// do this, but an extension worker can.
import {
  decide, isAllowedImageUrl, urlCacheKey, md5, markupPercent, parsePrice,
} from './lib.js';

const UPLOAD_HOST = 'https://recom-acs.aliexpress.com'; // no MTOP handshake needed
const UPLOAD_API = 'mtop.relationrecommend.AliexpressRecommend.recommend';
const UPLOAD_APPKEY = '24815441';
const UPLOAD_APPID = 21738;
const RESULTS_LOCALE = 'https://www.aliexpress.com';

const SHIP_TO = 'US';      // pinned, disclosed on the receipt so a third party can reproduce
const CURRENCY = 'USD';    // ditto — NOT derived from locale
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;     // chrome.storage.local has no LRU and a 10MB quota
const MIN_GAP_MS = 4000;   // token bucket: concurrency 1 bounds simultaneity, not rate
const HOURLY_CAP = 120;

// Default ON: silence is this extension's normal state, so a load-unpacked build
// with logging off is indistinguishable from a broken one. Opt out explicitly.
let debug = true;
chrome.storage.local.get('alibadgeDebug').then((r) => (debug = r.alibadgeDebug !== false));
const log = (...a) => debug && console.log('[alibadge]', ...a);
console.log('[alibadge] worker alive');

// --- serial queue + token bucket --------------------------------------------
// A serial queue alone does not limit requests per minute, which is what the
// marketplace's rate limiting actually counts.
let chain = Promise.resolve();
let lastStart = 0;
const hourStamps = [];

function enqueue(fn) {
  const run = chain.then(async () => {
    const now = Date.now();
    hourStamps.splice(0, hourStamps.findIndex((t) => now - t < 3600e3) + 1 || 0);
    if (hourStamps.filter((t) => now - t < 3600e3).length >= HOURLY_CAP) {
      return { render: 'none', reasons: ['rate_capped'] };
    }
    const wait = Math.max(0, MIN_GAP_MS - (now - lastStart));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    hourStamps.push(lastStart);
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

async function cacheGet(keys) {
  const got = await chrome.storage.local.get(keys.map((k) => 'c:' + k));
  for (const k of keys) {
    const hit = got['c:' + k];
    if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  }
  return null;
}

async function cachePut(keys, v) {
  const rec = { t: Date.now(), v };
  const put = {};
  for (const k of keys) put['c:' + k] = rec;
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
// MTOP handshake. The first call returns FAIL_SYS_TOKEN_EMPTY and sets _m_h5_tk;
// the token is the part before the "_". `recom-acs` does NOT skip this — verified
// against a live call, contrary to an earlier note in the design doc. Reading the
// cookie is why the `cookies` permission is required after all.
async function mtopToken() {
  try {
    const c = await chrome.cookies.get({ url: UPLOAD_HOST, name: '_m_h5_tk' });
    return c && c.value ? c.value.split('_')[0] : null;
  } catch {
    return null;
  }
}

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

async function uploadImage(b64, currency) {
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
  if (j && String(j.ret).includes('TOKEN_EMPTY')) {
    // The failed call just set the cookie; re-read it and sign again.
    j = await mtopCall(data, await mtopToken());
  }
  const fileId = j && j.data && j.data.fileId;
  log('upload', j && j.ret, fileId ? 'ok' : 'no fileId');
  return fileId || null;
}

// --- AliExpress: results -----------------------------------------------------
// Needs no cookies and no content-type. Returns 60 items; the rendered page only
// shows 12, so never scrape the DOM for this.
async function fetchResults(fileId) {
  const res = await fetch(`${RESULTS_LOCALE}/fn/search-pc/index`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isNewImageSearch: 'y', filename: fileId, pageVersion: '', page: 1 }),
  });
  if (!res.ok) return [];
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
  if (!Array.isArray(items)) {
    log('results: schema changed or empty');
    return [];
  }
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

// --- pipeline ----------------------------------------------------------------

async function lookup(extraction, pageOrigin) {
  const urlKey = urlCacheKey(extraction.url);
  const early = urlKey ? await cacheGet([urlKey]) : null;
  if (early) { log('cache hit (url)'); return early; }

  if (!isAllowedImageUrl(extraction.image, pageOrigin)) {
    return { render: 'none', reasons: ['image_url_disallowed'] };
  }

  const imgRes = await fetch(extraction.image, { credentials: 'omit' });
  if (!imgRes.ok) return { render: 'none', reasons: ['image_fetch_failed'] };
  const buf = await imgRes.arrayBuffer();

  const byteKey = await sha256(buf);
  const hit = await cacheGet([byteKey]);
  if (hit) { log('cache hit (bytes)'); return hit; }

  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const b64 = btoa(bin);

  const fileId = await uploadImage(b64, extraction.currency);
  // Nothing renders before a fileId exists: it is both the evidence that the
  // search ran and the only thing a results link can be built from.
  if (!fileId) return { render: 'none', reasons: ['upload_failed'] };

  let results;
  try {
    results = await fetchResults(fileId);
  } catch (e) {
    if (e && e.punished) {
      // A fileId exists, so the search DID run — degrade to the link rather than
      // going silent, which is the whole point of the link-only state.
      return {
        render: 'link-only',
        reasons: ['punished'],
        searchUrl: `https://www.aliexpress.com/w/wholesale-.html?isNewImageSearch=y&filename=${encodeURIComponent(fileId)}`,
      };
    }
    throw e;
  }
  // ponytail: no perceptual hash yet — AliExpress's own result rank IS a visual
  // similarity signal, and the brand guard + markup floor still gate. Add
  // blockhash when rank measurably admits wrong matches.
  const verdict = decide(extraction, results, null);

  const out = {
    render: verdict.render,
    reasons: verdict.reasons,
    searchUrl: `https://www.aliexpress.com/w/wholesale-.html?isNewImageSearch=y&filename=${encodeURIComponent(fileId)}`,
  };
  if (verdict.winner) {
    const ali = parsePrice(verdict.winner.price);
    Object.assign(out, {
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
  await cachePut(urlKey ? [byteKey, urlKey] : [byteKey], out);
  return out;
}

// --- messaging ---------------------------------------------------------------
// Every message carries a `target`, because chrome.runtime.sendMessage broadcasts
// to the whole extension origin and any other listener would also try to reply.
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
