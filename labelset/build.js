// probed.json -> set.json, the file the extension actually loads.
// Separate from probe.js so the set can be rebuilt without re-probing every store.
//
// Run: bun labelset/build.js
const probed = JSON.parse(await Bun.file('labelset/probed.json').text());

const items = [];
const dropped = [];
for (const store of probed) {
  // No currency means no safe comparison — the same rule extract() applies, so a
  // store the extension would skip must not sit in the measurement claiming USD.
  // Measured: hedleyandbennett.com serves /products.json but not /cart.js.
  if (!store.currency) { dropped.push(`${store.host} (no currency)`); continue; }
  for (const p of store.products.slice(0, 4)) {
    if (!Number.isFinite(p.price) || p.price <= 0) { dropped.push(`${store.host}/${p.handle} (no price)`); continue; }
    items.push({
      id: `${store.host}/${p.handle}`,
      bucket: store.bucket,
      fp: store.fp,
      host: store.host,
      title: p.title,
      vendor: p.vendor,
      price: p.price,
      currency: store.currency,
      image: p.image.startsWith('//') ? 'https:' + p.image : p.image,
    });
  }
}

await Bun.write('labelset/set.json', JSON.stringify(items, null, 2));

const by = (k) => items.reduce((a, i) => (a[i[k]] = (a[i[k]] || 0) + 1, a), {});
console.log(`set.json: ${items.length} items`);
console.log('  buckets   :', by('bucket'));
console.log('  currencies:', by('currency'));
if (dropped.length) console.log('  dropped   :', dropped.join(', '));
