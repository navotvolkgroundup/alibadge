// Integration smoke test: runs the worker's exact pipeline outside Chrome.
// bun has fetch, crypto.subtle and btoa, so everything except chrome.* works here.
// Run: bun smoke.js
import { md5, decide, parsePrice, markupPercent, isAllowedImageUrl } from './src/lib.js';

const UPLOAD_HOST = 'https://recom-acs.aliexpress.com';
const UPLOAD_API = 'mtop.relationrecommend.AliexpressRecommend.recommend';
const APPKEY = '24815441';
const APPID = 21738;

// warmlydecor "Royal Vintage Cutlery Set" — $84.95, the measured case.
const STORE = {
  url: 'https://warmlydecor.com/products/royal-vintage-cutlery-set',
  host: 'warmlydecor.com',
  title: 'Royal Vintage Cutlery Set',
  price: 84.95,
  currency: 'USD',
  image: 'https://cdn.shopify.com/s/files/1/0046/5702/1041/products/product-image-1410527736.jpg',
};

// MTOP handshake: the FIRST call always returns FAIL_SYS_TOKEN_EMPTY and sets an
// _m_h5_tk cookie. The token is the part before the "_". recom-acs does NOT skip
// this, contrary to an earlier note in the design doc.
function tokenFrom(setCookies) {
  for (const c of setCookies || []) {
    const m = /(?:^|;\s*)_m_h5_tk=([^;_]+)_/.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function call(data, token, cookie) {
  const t = Date.now();
  const sign = md5([token || '', t, APPKEY, data].join('&'));
  const qs = new URLSearchParams({
    jsv: '2.5.1', appKey: APPKEY, t: String(t), sign,
    api: UPLOAD_API, v: '1.0', type: 'originaljson', dataType: 'json', timeout: '50000',
  });
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${UPLOAD_HOST}/h5/${UPLOAD_API.toLowerCase()}/1.0/?${qs}`, {
    method: 'POST', credentials: 'omit', headers,
    body: 'data=' + encodeURIComponent(data),
  });
  const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const j = await res.json().catch(() => null);
  return { j, setC };
}

async function upload(b64) {
  const params = {
    appId: APPID, isNewImageSearch: true, osf: 'pc_web_image_search', page: 1, pageSize: 60,
    clientType: 'pc', searchBizScene: 'imageSearch', subScenario: 'imageUpload',
    contentType: 'imageUpload', image_base64: b64, shpt_co: 'US', _currency: 'USD',
    sortType: 'default', sortOrder: 'default', timeout: 50000, platform: 'pc',
  };
  const data = JSON.stringify({ appId: APPID, params: JSON.stringify(params) });

  // 1st call: expected to fail, harvest the token.
  const first = await call(data, null, null);
  const token = tokenFrom(first.setC);
  const jar = (first.setC || []).map((c) => c.split(';')[0]).join('; ');
  console.log('   handshake ret:', first.j && first.j.ret, '| token:', token ? token.slice(0, 10) + '…' : 'none');
  if (first.j?.data?.fileId) return { ret: first.j.ret, fileId: first.j.data.fileId };
  if (!token) return { ret: first.j && first.j.ret, fileId: null };

  // 2nd call: signed with the token, cookie echoed back.
  const second = await call(data, token, jar);
  return { ret: second.j && second.j.ret, fileId: second.j?.data?.fileId };
}

async function results(fileId, attempt = 1) {
  const res = await fetch('https://www.aliexpress.com/fn/search-pc/index', {
    method: 'POST', credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isNewImageSearch: 'y', filename: fileId, pageVersion: '', page: 1 }),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  const items = j?.data?.data?.root?.fields?.mods?.itemList?.content;
  if (!Array.isArray(items)) {
    console.log(`   attempt ${attempt}: status=${res.status} ct=${res.headers.get('content-type')} len=${text.length}`);
    console.log('   body head:', JSON.stringify(text.slice(0, 160)));
    // fileIds appear to need a moment to propagate to the search index.
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 2500 * attempt));
      return results(fileId, attempt + 1);
    }
    return { status: res.status, items: null, raw: j ? Object.keys(j) : null };
  }
  return {
    status: res.status,
    items: items.map((it) => ({
      productId: it.productId,
      title: it.title?.displayTitle || '',
      price: it.prices?.salePrice?.minPrice ?? it.prices?.salePrice?.formattedPrice ?? null,
      currency: it.prices?.salePrice?.currencyCode || null,
      sold: it.trade?.tradeDesc || null,
      url: it.productId ? `https://www.aliexpress.com/item/${it.productId}.html` : null,
    })).filter((r) => r.productId),
  };
}

// Recipe 3: price by productId. Different appKey (12574478) and its own handshake.
// Unlike the results endpoint, this one honours _currency and country per call.
const PDP_API = 'mtop.aliexpress.pdp.pc.query';
const PDP_APPKEY = '12574478';

async function pdpCall(data, token, cookie) {
  const t = Date.now();
  const sign = md5([token || '', t, PDP_APPKEY, data].join('&'));
  const qs = new URLSearchParams({
    jsv: '2.5.1', appKey: PDP_APPKEY, t: String(t), sign,
    api: PDP_API, v: '1.0', type: 'originaljson', dataType: 'json', timeout: '15000',
  });
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`https://acs.aliexpress.com/h5/${PDP_API}/1.0/?${qs}`, {
    method: 'POST', credentials: 'omit', headers,
    body: 'data=' + encodeURIComponent(data),
  });
  const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { j: await res.json().catch(() => null), setC };
}

async function pdpPrice(productId, currency) {
  const data = JSON.stringify({
    productId: String(productId), _lang: 'en_US', _currency: currency, country: 'US',
    province: '', city: '', channel: '', pdp_ext_f: '', pdpNPI: '', sourceType: '',
    clientType: 'pc',
    ext: JSON.stringify({ site: 'glo', crawler: false, signedIn: false, host: 'www.aliexpress.com' }),
  });
  let { j, setC } = await pdpCall(data, null, null);
  if (j && String(j.ret).includes('TOKEN_EMPTY')) {
    const m = (setC || []).map((c) => /_m_h5_tk=([^;_]+)_/.exec(c)).find(Boolean);
    const jar = (setC || []).map((c) => c.split(';')[0]).join('; ');
    if (m) ({ j } = await pdpCall(data, m[1], jar));
  }
  const s = JSON.stringify(j || {});
  const nums = [...s.matchAll(/"formatedAmount"\s*:\s*"[^\d"]*([\d.,]+)"/g)]
    .map((m) => parseFloat(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return null;
  // Dearest variant: the conservative direction. Measured, cheapest-vs-dearest
  // flipped the badge verdict on 3 of 10 products.
  return Math.max(...nums);
}

const step = (n, s) => console.log(`\n[${n}] ${s}`);

step(1, 'allowlist');
console.log('   image allowed:', isAllowedImageUrl(STORE.image, 'https://warmlydecor.com'));

step(2, 'fetch store image');
const buf = await (await fetch(STORE.image)).arrayBuffer();
console.log('   bytes:', buf.byteLength);

const bytes = new Uint8Array(buf);
let bin = '';
for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
const b64 = btoa(bin);
console.log('   base64 length:', b64.length, '(the ~8KB jsonp ceiling would reject this)');

step(3, 'sha256 cache key');
const d = await crypto.subtle.digest('SHA-256', buf);
console.log('   key:', [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join(''), '…');

step(4, 'upload (md5-signed, no cookies)');
const up = await upload(b64);
console.log('   ret:', up.ret, '\n   fileId:', up.fileId);
if (!up.fileId) { console.log('\nFAILED at upload'); process.exit(1); }

step(5, 'results');
const r = await results(up.fileId);
console.log('   status:', r.status, 'items:', r.items ? r.items.length : r.raw);
if (!r.items || !r.items.length) { console.log('\nFAILED at results'); process.exit(1); }
for (const it of r.items.slice(0, 5)) {
  console.log(`   ${String(it.price).padStart(8)} ${it.currency || ''}  ${(it.sold || '').padEnd(10)} ${it.title.slice(0, 44)}`);
}

step(6, 'authoritative price for candidates, in the STORE currency');
// The results endpoint returns whatever currency the caller's geo implies (ILS here),
// which decide() correctly refuses to compare against a USD store price. pdp.pc.query
// DOES take _currency/country per call, so it is the authoritative price source.
const priced = [];
for (const it of r.items.slice(0, 3)) {
  const p = await pdpPrice(it.productId, STORE.currency);
  console.log(`   ${it.productId}  ${p == null ? 'no price' : p + ' ' + STORE.currency}`);
  if (p != null) priced.push({ ...it, price: p, currency: STORE.currency });
}
if (!priced.length) { console.log('\nFAILED: no candidate priced in store currency'); process.exit(1); }

step(7, 'decide()');
const v = decide(STORE, priced, null);
console.log('   render :', v.render);
console.log('   reasons:', v.reasons.length ? v.reasons : '(none)');
if (v.winner) {
  const ali = parsePrice(v.winner.price);
  console.log('   winner :', v.winner.productId, ali, v.winner.currency);
  console.log('   markup :', '+' + markupPercent(STORE.price, ali) + '%');
}
console.log('\nPIPELINE OK');
