// Probe candidate stores for a usable /products.json, and fingerprint each one.
// No AliExpress calls: this is the free pre-gate the design doc argues for, and it
// decides which candidates are worth spending an upload on.
//
// Buckets:
//   dropship  — expected true positives (photo reuse likely)
//   easy_neg  — legitimate brands with no plausible AliExpress presence
//   hard_neg  — legitimate brands WITH known AliExpress counterfeits. The point of
//               the whole exercise: without this bucket the false-positive number
//               only measures the easy case.
//
// Run: bun labelset/probe.js
const CANDIDATES = [
  // --- dropship -------------------------------------------------------------
  ['dropship', 'warmlydecor.com'],
  ['dropship', 'petclever.net'],
  ['dropship', 'inspireuplift.com'],
  ['dropship', 'trendyhomegoods.com'],
  ['dropship', 'thegadgetflow.shop'],
  ['dropship', 'nordicnest.shop'],
  ['dropship', 'luxenest.co'],
  ['dropship', 'homefurnishop.com'],
  ['dropship', 'petlovershop.com'],
  ['dropship', 'gadgetsville.shop'],

  // --- easy negatives: real brands, nothing comparable on AliExpress --------
  ['easy_neg', 'shop.tonx.coffee'],
  ['easy_neg', 'deathwishcoffee.com'],
  ['easy_neg', 'hedleyandbennett.com'],
  ['easy_neg', 'misen.com'],
  ['easy_neg', 'greatjonesgoods.com'],
  ['easy_neg', 'burrowsandhare.co.uk'],

  // --- hard negatives: real brands WITH known AliExpress counterfeits -------
  ['hard_neg', 'www.stanley1913.com'],
  ['hard_neg', 'owalalife.com'],
  ['hard_neg', 'www.spigen.com'],
  ['hard_neg', 'www.otterbox.com'],
  ['hard_neg', 'www.yeti.com'],
  ['hard_neg', 'us.anker.com'],
  ['hard_neg', 'www.hydroflask.com'],
  ['hard_neg', 'www.ray-ban.com'],
  ['hard_neg', 'www.casetify.com'],
  ['hard_neg', 'peak-design.com'],
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Importer signatures from the design doc's 12-store survey. Used as the UNBIASED
// labeller: it keys on SKU/filename shape, which is independent of photo reuse, so
// it does not select the test set on the very thing being measured.
function fingerprint(products) {
  const hits = [];
  for (const p of products.slice(0, 40)) {
    const skus = (p.variants || []).map((v) => String(v.sku || ''));
    const imgs = (p.images || []).map((i) => String(typeof i === 'string' ? i : i.src || ''));
    if (skus.some((s) => /^\d{7,9}-/.test(s))) hits.push('dsers_sku');
    if (imgs.some((i) => /product-image-\d+\./.test(i))) hits.push('dsers_image');
    if (imgs.some((i) => /inspire-uplift-.*-\d{13}\./.test(i))) hits.push('inspireuplift');
    if (String(p.vendor || '').trim().toLowerCase() === 'my store') hits.push('my_store_vendor');
    if (skus.some((s) => /^[A-Z0-9]{10,}$/.test(s)) && imgs.some((i) => /\/[0-9a-f]{32}\./.test(i))) {
      hits.push('cj_zendrop');
    }
  }
  return [...new Set(hits)];
}

async function probe(host) {
  const url = `https://${host}/products.json?limit=40`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
    if (!res.ok) return { ok: false, why: 'http_' + res.status };
    const ct = res.headers.get('content-type') || '';
    if (!/json/.test(ct)) return { ok: false, why: 'not_json' };
    const j = await res.json();
    const products = j.products || [];
    if (!products.length) return { ok: false, why: 'no_products' };
    return { ok: true, n: products.length, fp: fingerprint(products), products };
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 40) };
  }
}

const rows = [];
for (const [bucket, host] of CANDIDATES) {
  const r = await probe(host);
  rows.push({ bucket, host, ...r });
  const tag = r.ok ? `${r.n} products  fp=[${r.fp.join(',') || '-'}]` : `SKIP ${r.why}`;
  console.log(`${bucket.padEnd(9)} ${host.padEnd(26)} ${tag}`);
  await new Promise((r2) => setTimeout(r2, 300));
}

const usable = rows.filter((r) => r.ok);
console.log(`\nusable: ${usable.length}/${rows.length}`);
for (const b of ['dropship', 'easy_neg', 'hard_neg']) {
  const u = usable.filter((r) => r.bucket === b);
  const fp = u.filter((r) => r.fp.length);
  console.log(`  ${b.padEnd(9)} ${u.length} usable, ${fp.length} carrying an importer signature`);
}

await Bun.write('labelset/probed.json', JSON.stringify(
  usable.map(({ bucket, host, fp, products }) => ({
    bucket, host, fp,
    // Keep only what the runner needs, and only products with an image and a price.
    products: products
      .filter((p) => (p.images || []).length && (p.variants || []).length)
      .slice(0, 6)
      .map((p) => ({
        handle: p.handle,
        title: p.title,
        vendor: p.vendor,
        price: parseFloat(p.variants[0].price),
        image: String(p.images[0].src || p.images[0]),
      })),
  })), null, 2));
console.log('\nwrote labelset/probed.json');
