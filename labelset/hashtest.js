// Does perceptual-hash distance separate "reused supplier photo" from "the brand's own
// photography"? That is premise 2 stated precisely, and it is the question both cheaper
// proxies (importer fingerprint, brand token list) are standing in for.
//
// For each measured row with a known winner, hash the STORE image and every image in the
// winner's AliExpress gallery, and keep the CLOSEST match — the reused photo can be any
// gallery image, not necessarily the first.
//
// Needs the item pages fetched to a directory (ordinary page traffic, not the punished
// search API):
//   curl -sSL 'https://www.aliexpress.com/item/<id>.html' -o item-<id>.html
//
// Run: bun labelset/hashtest.js <dir-with-item-html>
const dir = process.argv[2];
if (!dir) { console.error('usage: bun labelset/hashtest.js <dir>'); process.exit(1); }

const rows = (await Bun.file('labelset/run1-merged.jsonl').text())
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const set = JSON.parse(await Bun.file('labelset/set.json').text());

// The hand-rebuilt rows carry shortened ids, so match store images on host + a token.
function storeImageFor(row) {
  const host = row.id.split('/')[0];
  const slug = row.id.split('/').slice(1).join('/');
  const cands = set.filter((x) => x.host === host);
  const exact = cands.find((x) => x.id === row.id);
  if (exact) return exact.image;
  // Longest shared token wins; ids were abbreviated by hand, not algorithmically.
  const toks = slug.split(/[^a-z0-9]+/i).filter((t) => t.length > 3);
  let best = null, bestScore = -1;
  for (const c of cands) {
    const score = toks.filter((t) => c.id.toLowerCase().includes(t.toLowerCase())).length;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore > 0 && best ? best.image : null;
}

// dHash via Pillow: 9x8 greyscale, one bit per horizontal gradient. Robust to scaling
// and re-encoding, which is exactly what a store does to a supplier photo.
async function dhash(pathOrUrl) {
  const py = `
import sys, io, urllib.request
from PIL import Image
src = sys.argv[1]
data = urllib.request.urlopen(urllib.request.Request(src, headers={'User-Agent':'Mozilla/5.0'})).read() if src.startswith('http') else open(src,'rb').read()
im = Image.open(io.BytesIO(data)).convert('L').resize((9, 8), Image.LANCZOS)
px = list(im.getdata())
bits = ''.join('1' if px[r*9+c] < px[r*9+c+1] else '0' for r in range(8) for c in range(8))
print(bits)
`;
  const p = Bun.spawnSync(['python3', '-c', py, pathOrUrl]);
  if (!p.success) return null;
  const bits = p.stdout.toString().trim();
  return bits.length === 64 ? bits : null;
}

const hamming = (a, b) => {
  let d = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
  return d;
};

// Every gallery image on the winner's page.
async function galleryFor(id) {
  const html = await Bun.file(`${dir}/item-${id}.html`).text().catch(() => '');
  const found = html.match(/https?:\/\/ae0[0-9]\.alicdn\.com\/kf\/[A-Za-z0-9_\-.]+\.(?:jpg|png|jpeg)/g) || [];
  return [...new Set(found)].slice(0, 8);
}

const cache = new Map();
const hashOf = async (u) => {
  if (!cache.has(u)) cache.set(u, await dhash(u));
  return cache.get(u);
};

const out = [];
for (const row of rows) {
  if (!row.aliUrl) continue;
  const id = (row.aliUrl.match(/item\/(\d+)/) || [])[1];
  if (!id) continue;
  const gallery = await galleryFor(id);
  if (!gallery.length) continue;
  const storeImg = storeImageFor(row);
  if (!storeImg) continue;

  const sh = await hashOf(storeImg.startsWith('//') ? 'https:' + storeImg : storeImg);
  if (!sh) continue;
  let best = 64, bestUrl = null;
  for (const g of gallery) {
    const gh = await hashOf(g);
    if (!gh) continue;
    const d = hamming(sh, gh);
    if (d < best) { best = d; bestUrl = g; }
  }
  out.push({ id: row.id, bucket: row.bucket, render: row.render, distance: best, match: bestUrl });
  console.log(`${String(best).padStart(2)}  ${row.bucket.padEnd(9)} ${String(row.render).padEnd(10)} ${row.id}`);
}

console.log('\n--- distance by bucket (lower = more likely the SAME photograph) ---');
for (const b of ['dropship', 'easy_neg', 'hard_neg']) {
  const g = out.filter((r) => r.bucket === b);
  if (!g.length) continue;
  const ds = g.map((r) => r.distance).sort((a, b2) => a - b2);
  const mean = (ds.reduce((a, c) => a + c, 0) / ds.length).toFixed(1);
  console.log(`  ${b.padEnd(9)} n=${g.length}  min=${ds[0]}  median=${ds[Math.floor(ds.length / 2)]}  max=${ds[ds.length - 1]}  mean=${mean}`);
}

// Sweep thresholds against the VERDICTS, not against the bucket labels.
//
// An earlier version compared all dropship distances to all negative distances and
// declared the data inseparable. That framing was wrong: it assumed every dropship row
// deserves a badge, when two of them are winner-collapse artifacts — distinct cutlery
// sets matched to one listing whose photo is 31-36 away. The gate is SUPPOSED to reject
// those. What matters is how many surviving full badges are false.
const sorted = out.map((r) => r.distance).sort((a, b) => a - b);
console.log(`\nall distances: ${sorted.join(', ')}`);
let gapAt = -1, gapSize = 0;
for (let i = 1; i < sorted.length; i++) {
  if (sorted[i] - sorted[i - 1] > gapSize) { gapSize = sorted[i] - sorted[i - 1]; gapAt = i; }
}
if (gapAt > 0) {
  console.log(`largest gap: ${sorted[gapAt - 1]} -> ${sorted[gapAt]} (${gapSize} bits) — ` +
    `photo IDENTITY below, mere similarity above`);
}
console.log('\nthreshold  badges kept   false   true');
for (const t of [5, 10, 15, 20, 25, 64]) {
  const kept = out.filter((r) => r.render === 'full' && r.distance <= t);
  const fp = kept.filter((r) => r.bucket !== 'dropship').length;
  console.log(`  <= ${String(t).padEnd(4)} ${String(kept.length).padStart(9)} ${String(fp).padStart(7)} ${String(kept.length - fp).padStart(6)}`);
}
await Bun.write('labelset/hashtest.json', JSON.stringify(out, null, 2));
