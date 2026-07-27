// Score harvested candidates through the REAL decide(). The browser harness only
// collects raw candidates; the policy runs here, so the harness cannot grade itself
// with different rules than the extension ships.
//
// Run: bun labelset/score.js labelset/harvest.json
import { decide, md5, parsePrice } from '../src/lib.js';

const path = process.argv[2] || 'labelset/harvest.json';
const rows = JSON.parse(await Bun.file(path).text());

// Deterministic split, so re-running never reshuffles what counts as held-out.
const half = (id) => (md5(id).charCodeAt(0) % 2 === 0 ? 'tune' : 'holdout');

const scored = rows.map((r) => {
  const extraction = {
    url: `https://${r.host}/products/x`, host: r.host, title: r.title,
    vendor: r.vendor, price: r.price, currency: r.currency, image: r.image,
  };
  const cands = (r.cands || []).map((c) => ({ ...c }));
  const v = cands.length ? decide(extraction, cands, null) : { render: 'link-only', reasons: [r.outcome || 'no_results'], winner: null };
  const ali = v.winner ? parsePrice(v.winner.price) : null;
  return {
    id: r.id, bucket: r.bucket, half: half(r.id), fp: (r.fp || []).length > 0,
    outcome: r.outcome,
    render: v.render, reasons: v.reasons || [], note: v.note || null,
    storePrice: r.price, storeCur: r.currency,
    aliPrice: ali, aliCur: v.winner ? v.winner.currency : null,
    aliTitle: v.winner ? v.winner.title : null,
    ratio: ali && v.winner && v.winner.currency === r.currency ? +(r.price / ali).toFixed(2) : null,
    n: r.n ?? 0,
  };
});

await Bun.write('labelset/scored.json', JSON.stringify(scored, null, 2));

const BUCKETS = ['dropship', 'easy_neg', 'hard_neg'];
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');

function report(rowsIn, label) {
  console.log(`\n=== ${label} (n=${rowsIn.length}) ===`);
  console.log('bucket     n   full  link  none   plumbing');
  for (const b of BUCKETS) {
    const g = rowsIn.filter((r) => r.bucket === b);
    if (!g.length) continue;
    const full = g.filter((r) => r.render === 'full').length;
    const link = g.filter((r) => r.render === 'link-only').length;
    const none = g.filter((r) => r.render === 'none').length;
    const plumb = g.filter((r) => r.outcome === 'ok' && r.n > 0).length;
    console.log(`${b.padEnd(10)} ${String(g.length).padStart(2)}  ${String(full).padStart(4)}  ` +
      `${String(link).padStart(4)}  ${String(none).padStart(4)}   ${plumb}/${g.length} ${pct(plumb, g.length)}`);
  }
  // The number the success criteria actually turn on.
  const hn = rowsIn.filter((r) => r.bucket === 'hard_neg');
  const en = rowsIn.filter((r) => r.bucket === 'easy_neg');
  const dp = rowsIn.filter((r) => r.bucket === 'dropship');
  console.log(`\n  FALSE POSITIVES (a full badge on a negative):`);
  console.log(`    hard negatives: ${hn.filter((r) => r.render === 'full').length}/${hn.length}  <- primary criterion, must be 0`);
  console.log(`    easy negatives: ${en.filter((r) => r.render === 'full').length}/${en.length}`);
  console.log(`  TRUE POSITIVES: ${dp.filter((r) => r.render === 'full').length}/${dp.length} dropship items badged`);
}

report(scored, 'ALL');
report(scored.filter((r) => r.half === 'holdout'), 'HELD OUT');

// Why negatives were rejected — a bucket that is quiet for the wrong reason (no
// results, a network failure) is not evidence the guards work.
console.log('\nreasons on negatives:');
const tally = {};
for (const r of scored.filter((x) => x.bucket !== 'dropship' && x.render !== 'full')) {
  for (const why of (r.reasons.length ? r.reasons : ['(rendered, no reason)'])) tally[why] = (tally[why] || 0) + 1;
}
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);

const notes = scored.filter((r) => r.note);
console.log(`\ncaveats printed: ${notes.length}`);
for (const r of notes.slice(0, 12)) console.log(`  [${r.bucket}] ${r.note}  — ${r.id}`);

const fp = scored.filter((r) => r.bucket === 'hard_neg' && r.render === 'full');
if (fp.length) {
  console.log('\nFALSE POSITIVES IN DETAIL:');
  for (const r of fp) {
    console.log(`  ${r.id}\n    store ${r.storePrice} ${r.storeCur} vs ali ${r.aliPrice} ${r.aliCur} = ${r.ratio}x`);
    console.log(`    matched: ${r.aliTitle}`);
    console.log(`    note: ${r.note || '(none — renders a bare number)'}`);
  }
}
console.log('\nwrote labelset/scored.json');
