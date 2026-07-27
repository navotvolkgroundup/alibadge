// Score the labelled set through the shipped policy: upload -> results (in the
// store's currency) -> optional dearest-variant lookup -> decide().
//
// Appends to labelset/results.jsonl and skips anything already there, because
// /fn/search-pc/index rate-punishes: a run that dies halfway must not cost its
// uploads. Re-run until `pending` reaches 0.
//
// Run: bun labelset/run.js [maxItems]
import { md5, decide, parsePrice, dearestFromSkuMap } from '../src/lib.js';

const UPLOAD_HOST = 'https://recom-acs.aliexpress.com';
const UPLOAD_API = 'mtop.relationrecommend.AliexpressRecommend.recommend';
const UPLOAD_APPKEY = '24815441';
const APPID = 21738;
const PDP_API = 'mtop.aliexpress.pdp.pc.query';
const PDP_APPKEY = '12574478';
const PDP_HOST = 'https://acs.aliexpress.com';
const SHIP_TO = 'US';
// Measured: at 4.5s bun gets ~4 items before /fn/search-pc/index walls. Slower is the
// only lever available from a non-browser client.
const GAP_MS = parseInt(process.env.GAP_MS || '20000', 10);
const OUT = process.env.OUT || 'labelset/results.jsonl';
// Mirrors encodeForUpload() in the worker. MEASURED: the upload silently returns no
// fileId on large payloads — Stanley 7.0MB PNG, Otterbox 1.9MB, Anker 870KB all failed
// while Spigen's 70KB JPEG worked. bun has no OffscreenCanvas, so use macOS sips, which
// is preinstalled and does exactly this.
const UPLOAD_MAX_PX = 1200;
const UPLOAD_MAX_BYTES = 400 * 1024;

async function encodeForUpload(buf, tag) {
  const b64 = (b) => {
    const u = new Uint8Array(b);
    let bin = '';
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  if (buf.byteLength <= UPLOAD_MAX_BYTES) return b64(buf);
  const safe = tag.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  const src = `/tmp/alibadge-${safe}.bin`;
  const dst = `/tmp/alibadge-${safe}.jpg`;
  await Bun.write(src, buf);
  const p = Bun.spawnSync(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80',
    '-Z', String(UPLOAD_MAX_PX), src, '--out', dst]);
  if (!p.success) { console.log(`    sips failed, using original (${Math.round(buf.byteLength / 1024)}KB)`); return b64(buf); }
  const out = await Bun.file(dst).arrayBuffer();
  console.log(`    downscaled ${Math.round(buf.byteLength / 1024)}KB -> ${Math.round(out.byteLength / 1024)}KB`);
  return b64(out);
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const tokenFrom = (cs) => {
  for (const c of cs || []) {
    const m = /_m_h5_tk=([^;]+)/.exec(c);
    if (m) return m[1].split('_')[0];
  }
  return null;
};

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
  return { json: await res.json().catch(() => null), setCookies: res.headers.getSetCookie?.() || [] };
}

// The first call always returns FAIL_SYS_TOKEN_EMPTY and sets _m_h5_tk.
async function mtopSigned(opts) {
  let r = await mtop(opts);
  const tok = tokenFrom(r.setCookies);
  if (r.json && String(r.json.ret).includes('TOKEN_EMPTY') && tok) {
    const cookie = r.setCookies.map((c) => c.split(';')[0]).join('; ');
    r = await mtop({ ...opts, token: tok, cookie });
  }
  return r.json;
}

async function upload(b64, currency) {
  const params = {
    appId: APPID, isNewImageSearch: true, osf: 'pc_web_image_search', page: 1,
    pageSize: 60, clientType: 'pc', searchBizScene: 'imageSearch',
    subScenario: 'imageUpload', contentType: 'imageUpload', image_base64: b64,
    shpt_co: SHIP_TO, _currency: currency,
    sortType: 'default', sortOrder: 'default', timeout: 50000, platform: 'pc',
  };
  const j = await mtopSigned({
    host: UPLOAD_HOST, api: UPLOAD_API, appKey: UPLOAD_APPKEY,
    data: JSON.stringify({ appId: APPID, params: JSON.stringify(params) }),
  });
  return { fileId: j?.data?.fileId || null, ret: String(j?.ret) };
}

// The currency comes from the aep_usuc_f COOKIE, not a parameter — measured on one
// fileId back to back: with c_tp=USD, 60 USD items; without, 60 ILS items. Getting
// this wrong compares dollars to shekels and inflates every ratio by the FX rate,
// which is the most likely explanation for the design doc's premise-2 numbers.
async function fetchResults(fileId, currency) {
  const res = await fetch('https://www.aliexpress.com/fn/search-pc/index', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': UA,
      origin: 'https://www.aliexpress.com',
      referer: 'https://www.aliexpress.com/',
      cookie: `aep_usuc_f=site=glo&c_tp=${currency}&region=${SHIP_TO}&b_locale=en_US`,
    },
    body: JSON.stringify({ isNewImageSearch: 'y', filename: fileId, pageSize: 60, page: 1 }),
  });
  const text = await res.text();
  // HTTP 200 with an HTML punish redirect: status alone never reveals it.
  if (/_____tmd_____|x5secdata|RGV587/.test(text)) return { punished: true, items: [] };
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
      image: it.image?.imgUrl ? 'https:' + String(it.image.imgUrl).replace(/^https?:/, '') : null,
      url: `https://www.aliexpress.com/item/${it.productId}.html`,
    })),
  };
}

// Dearest variant for ONE product. Punished from a non-browser client when measured
// earlier today; tried anyway per item and the success rate is reported, because it
// decides whether these markups are measurements or upper bounds.
async function pdpDearest(productId, currency) {
  const data = JSON.stringify({
    productId: String(productId), _currency: currency,
    country: SHIP_TO, locale: 'en_US', pdp_ext_f: '{}',
  });
  const j = await mtopSigned({ host: PDP_HOST, api: PDP_API, appKey: PDP_APPKEY, data });
  if (!j || /PUNISH|VALIDATE|RGV587/i.test(String(j.ret))) return { price: null, ret: String(j?.ret) };
  const find = (o, name, d = 0) => {
    if (!o || typeof o !== 'object' || d > 8) return null;
    if (o[name]) return o[name];
    for (const v of Object.values(o)) { const r = find(v, name, d + 1); if (r) return r; }
    return null;
  };
  return { price: dearestFromSkuMap(find(j, 'skuPriceInfoMap'), currency), ret: String(j?.ret) };
}

// --- run ---------------------------------------------------------------------

const SET = process.env.SET || 'labelset/set.json';
const items = JSON.parse(await Bun.file(SET).text());
// Only MEASURED items count as done. A punish or a network failure must be retried,
// or the final set silently contains rows that never reached a comparison and the
// scorer's "comparable" rate is computed over work that never happened.
const RETRY = /^(punished|no_results|upload_failed|image_fetch_failed|harness_error|rate_capped)/;
const done = new Set();
try {
  for (const line of (await Bun.file(OUT).text()).split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (!(r.reasons || []).some((x) => RETRY.test(x))) done.add(r.id);
  }
} catch {}

const todo = items.filter((i) => !done.has(i.id));
const batch = todo.slice(0, parseInt(process.argv[2] || '40', 10));
console.log(`set ${items.length} · done ${done.size} · pending ${todo.length} · batch ${batch.length}\n`);

const out = [];
let punishes = 0;
for (const [n, item] of batch.entries()) {
  if (n) await new Promise((r) => setTimeout(r, GAP_MS));
  const rec = { id: item.id, bucket: item.bucket, fp: item.fp, host: item.host,
    title: item.title, vendor: item.vendor, price: item.price, currency: item.currency };
  try {
    const buf = await (await fetch(item.image, { headers: { 'user-agent': UA } })).arrayBuffer();
    const up = await upload(await encodeForUpload(buf, item.id), item.currency);
    if (!up.fileId) { rec.render = 'none'; rec.reasons = ['upload_failed']; rec.detail = up.ret; out.push(rec); console.log(`  upload_failed ${item.id} ${up.ret}`); continue; }

    const r = await fetchResults(up.fileId, item.currency);
    if (r.punished) {
      punishes++;
      rec.render = 'link-only'; rec.reasons = ['punished'];
      out.push(rec);
      console.log(`  PUNISHED ${item.id}`);
      if (punishes >= 3) { console.log('\n3 punishes — stopping, the endpoint is walling us.'); break; }
      continue;
    }
    if (!r.items.length) { rec.render = 'link-only'; rec.reasons = ['no_results']; out.push(rec); console.log(`  no_results ${item.id}`); continue; }

    // Shipped selection: decide() picks results[0] when there is no gate.
    let results = r.items;
    const provisional = decide({ ...item }, results, null);
    if (provisional.winner) {
      const d = await pdpDearest(provisional.winner.productId, item.currency);
      const cur = parsePrice(provisional.winner.price);
      if (d.price != null && cur != null && d.price >= cur && d.price <= cur * 50) {
        const id = provisional.winner.productId;
        results = results.map((x) => (x.productId === id
          ? { ...x, price: d.price, currency: item.currency, basis: 'dearest' } : x));
        rec.pdp = 'ok';
      } else {
        rec.pdp = d.price == null ? 'failed' : 'out_of_band';
      }
    }

    const v = decide({ ...item }, results, null);
    rec.render = v.render;
    rec.reasons = v.reasons;
    rec.note = v.note || null;
    rec.aliPrice = v.winner ? parsePrice(v.winner.price) : null;
    rec.aliCurrency = v.winner ? v.winner.currency : null;
    rec.aliTitle = v.winner ? v.winner.title : null;
    rec.markup = rec.aliPrice ? Math.round(((item.price - rec.aliPrice) / rec.aliPrice) * 100) : null;
    rec.ratio = rec.aliPrice ? +(item.price / rec.aliPrice).toFixed(2) : null;
    rec.n = r.items.length;
    out.push(rec);
    console.log(`  ${rec.bucket.padEnd(9)} ${String(rec.render).padEnd(10)} ` +
      `${rec.ratio ? rec.ratio + 'x' : '—'} pdp=${rec.pdp || '-'} ${(rec.reasons || []).join(',')} ${item.id}`);
  } catch (e) {
    rec.render = 'none'; rec.reasons = ['harness_error']; rec.detail = String(e.message || e).slice(0, 70);
    out.push(rec);
    console.log(`  ERROR ${item.id} ${rec.detail}`);
  }
}

if (out.length) {
  // Rewrite rather than append: a retried item must REPLACE its punished row, not sit
  // beside it, or the scorer counts one product twice with contradictory verdicts.
  const fresh = new Map(out.map((r) => [r.id, r]));
  const kept = [];
  try {
    for (const line of (await Bun.file(OUT).text()).split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (!fresh.has(r.id)) kept.push(r);
    }
  } catch {}
  const all = kept.concat([...fresh.values()]);
  await Bun.write(OUT, all.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nwrote ${all.length} rows -> ${OUT} (${out.length} this batch)`);
}
