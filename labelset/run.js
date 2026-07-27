// Score the labelled set through the REAL pipeline: upload → results → re-price →
// decide(). Answers open question 1 (premise 2 at scale, with hard negatives).
//
// Appends to labelset/results.jsonl and skips anything already there, because
// /fn/search-pc/index rate-punishes non-browser clients: a run that dies halfway
// must not cost its uploads. Re-run until `pending` reaches 0.
//
// Run: bun labelset/run.js [maxItems]
import { md5, decide, parsePrice } from '../src/lib.js';

const UPLOAD_HOST = 'https://recom-acs.aliexpress.com';
const UPLOAD_API = 'mtop.relationrecommend.AliexpressRecommend.recommend';
const APPKEY = '24815441';
const APPID = 21738;
const PDP_API = 'mtop.aliexpress.pdp.pc.query';
const PDP_APPKEY = '12574478';
const SHIP_TO = 'US';
const CURRENCY = 'USD';
const GAP_MS = 4500;
const OUT = 'labelset/results.jsonl';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function tokenFrom(setCookies) {
  for (const c of setCookies || []) {
    const m = /_m_h5_tk=([^;]+)/.exec(c);
    if (m) return m[1].split('_')[0];
  }
  return null;
}

async function mtop({ host, api, appKey, data, token, cookie }) {
  const t = Date.now();
  const sign = md5([token || '', t, appKey, data].join('&'));
  const qs = new URLSearchParams({
    jsv: '2.5.1', appKey, t: String(t), sign, api, v: '1.0',
    type: 'originaljson', dataType: 'json', timeout: '20000',
  });
  const res = await fetch(`${host}/h5/${api.toLowerCase()}/1.0/?${qs}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
      ...(cookie ? { cookie } : {}),
    },
    body: 'data=' + encodeURIComponent(data),
  });
  const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { json: await res.json().catch(() => null), setCookies: setC };
}

// Handshake then real call. The first attempt always returns FAIL_SYS_TOKEN_EMPTY.
async function mtopSigned(opts) {
  let r = await mtop(opts);
  const tok = tokenFrom(r.setCookies);
  if (r.json && String(r.json.ret).includes('TOKEN_EMPTY') && tok) {
    const cookie = (r.setCookies || []).map((c) => c.split(';')[0]).join('; ');
    r = await mtop({ ...opts, token: tok, cookie });
  }
  return r.json;
}

async function upload(b64, currency) {
  const params = {
    appId: APPID, isNewImageSearch: true, osf: 'pc_web_image_search', page: 1,
    pageSize: 60, clientType: 'pc', searchBizScene: 'imageSearch',
    subScenario: 'imageUpload', contentType: 'imageUpload', image_base64: b64,
    shpt_co: SHIP_TO, _currency: currency || CURRENCY,
    sortType: 'default', sortOrder: 'default', timeout: 50000, platform: 'pc',
  };
  const j = await mtopSigned({
    host: UPLOAD_HOST, api: UPLOAD_API, appKey: APPKEY,
    data: JSON.stringify({ appId: APPID, params: JSON.stringify(params) }),
  });
  return { fileId: (j && j.data && j.data.fileId) || null, ret: j && j.ret };
}

async function fetchResults(fileId) {
  const url = 'https://www.aliexpress.com/fn/search-pc/index';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': UA,
      origin: 'https://www.aliexpress.com',
      referer: 'https://www.aliexpress.com/',
    },
    body: JSON.stringify({ isNewImageSearch: 'y', filename: fileId, pageSize: 60, page: 1 }),
  });
  const text = await res.text();
  // HTTP 200 with an HTML punish redirect. Status alone never reveals this.
  if (/_____tmd_____|punish/.test(text)) return { punished: true, items: [] };
  if (!res.ok) return { httpStatus: res.status, items: [] };
  let j;
  try { j = JSON.parse(text); } catch { return { unparseable: true, items: [] }; }
  const content = j?.data?.data?.root?.fields?.mods?.itemList?.content || [];
  return {
    items: content.map((it) => ({
      productId: it.productId,
      title: it.title?.displayTitle || it.title?.seoTitle || '',
      price: it.prices?.salePrice?.formattedPrice || null,
      currency: it.prices?.salePrice?.currencyCode || null,
      sold: it.trade?.tradeDesc || null,
      image: it.image?.imgUrl ? 'https:' + it.image.imgUrl.replace(/^https?:/, '') : null,
      url: `https://www.aliexpress.com/item/${it.productId}.html`,
    })),
  };
}

// Dearest variant, in the store's currency. Same choice the worker makes.
async function pdpPrice(productId, currency) {
  const data = JSON.stringify({
    productId: String(productId), _currency: currency || CURRENCY,
    country: SHIP_TO, locale: 'en_US', pdp_ext_f: '{}',
  });
  const j = await mtopSigned({
    host: 'https://acs.aliexpress.com', api: PDP_API, appKey: PDP_APPKEY, data,
  });
  const nums = [];
  JSON.stringify(j || {}).replace(/"(?:formatted|min|max)?[Pp]rice"\s*:\s*"?([\d.,]+)"?/g,
    (_, n) => { const v = parseFloat(String(n).replace(/,/g, '')); if (v > 0) nums.push(v); return _; });
  return nums.length ? Math.max(...nums) : null;
}

// --- the set -----------------------------------------------------------------

const probed = JSON.parse(await Bun.file('labelset/probed.json').text());
const items = [];
for (const store of probed) {
  for (const p of store.products.slice(0, 4)) {
    items.push({
      id: `${store.host}/${p.handle}`,
      bucket: store.bucket,
      fp: store.fp,
      host: store.host,
      url: `https://${store.host}/products/${p.handle}`,
      title: p.title,
      vendor: p.vendor,
      price: p.price,
      currency: 'USD', // every probed store priced in USD; asserted below
      image: p.image.startsWith('//') ? 'https:' + p.image : p.image,
    });
  }
}

// Deterministic split so re-runs never reshuffle. Tuning half is looked at; the
// held-out half is what the success criteria are actually measured against.
const half = (id) => (md5(id).charCodeAt(0) % 2 === 0 ? 'tune' : 'holdout');

const done = new Set();
try {
  for (const line of (await Bun.file(OUT).text()).split('\n')) {
    if (line.trim()) done.add(JSON.parse(line).id);
  }
} catch {}

const todo = items.filter((i) => !done.has(i.id));
const limit = parseInt(process.argv[2] || '12', 10);
const batch = todo.slice(0, limit);
console.log(`set ${items.length} items · done ${done.size} · pending ${todo.length} · this batch ${batch.length}\n`);

const out = [];
for (const [n, item] of batch.entries()) {
  if (n) await new Promise((r) => setTimeout(r, GAP_MS));
  const rec = { id: item.id, bucket: item.bucket, half: half(item.id), fp: item.fp };
  try {
    const buf = await (await fetch(item.image, { headers: { 'user-agent': UA } })).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const up = await upload(btoa(bin), item.currency);
    if (!up.fileId) throw new Error('upload_failed:' + up.ret);

    const r = await fetchResults(up.fileId);
    if (r.punished) { rec.outcome = 'punished'; out.push(rec); console.log(`${rec.id} PUNISHED — stopping`); break; }
    if (!r.items.length) { rec.outcome = 'no_results'; rec.detail = r.httpStatus || r.unparseable || null; }
    else {
      // Re-price the top 3 exactly as the worker does.
      const head = r.items.slice(0, 3);
      const fixed = [];
      for (const c of head) {
        if (c.currency === item.currency) { fixed.push(c); continue; }
        const p = await pdpPrice(c.productId, item.currency);
        if (p != null) fixed.push({ ...c, price: p, currency: item.currency });
      }
      const priced = (fixed.length ? fixed : []).concat(r.items.slice(3));
      const v = decide(item, priced, null);
      rec.outcome = v.render;
      rec.reasons = v.reasons;
      rec.note = v.note || null;
      rec.storePrice = item.price;
      rec.aliPrice = v.winner ? parsePrice(v.winner.price) : null;
      rec.aliTitle = v.winner ? v.winner.title : null;
      rec.ratio = rec.aliPrice ? +(item.price / rec.aliPrice).toFixed(2) : null;
      rec.repriced = fixed.length;
    }
  } catch (e) {
    rec.outcome = 'error';
    rec.detail = String(e.message || e).slice(0, 60);
  }
  out.push(rec);
  console.log(`${rec.bucket.padEnd(9)} ${rec.half.padEnd(7)} ${rec.outcome.padEnd(10)} ` +
    `${rec.ratio ? rec.ratio + 'x' : ''} ${(rec.reasons || []).join(',')} ${rec.id}`);
}

if (out.length) {
  await Bun.write(OUT, (done.size ? await Bun.file(OUT).text() : '') +
    out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nappended ${out.length} → ${OUT}`);
}
