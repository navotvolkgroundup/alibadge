// Score harvested candidates through the REAL decide(). The browser harness only
// collects raw candidates; the policy runs here, so the harness cannot grade itself
// with different rules than the extension ships.
//
// Run: bun labelset/score.js labelset/harvest.json
import { decide, md5, parsePrice } from '../src/lib.js';

// Either a file, or the JSON the worker logs when the POST is blocked:
//   pbpaste | bun labelset/score.js -
const src = process.argv[2] || 'labelset/harvest.json';
const rows = JSON.parse(src === '-' ? await Bun.stdin.text() : await Bun.file(src).text());

// Reasons that mean no comparison happened, so nothing was tested. Distinguished
// from a real gate decision (below_ratio_floor, ratio_implausible, brand guards,
// no_passing_match) — those are the matcher and the guards doing their job.
const NOT_COMPARABLE =
  /^(no_results|punished|upload_failed|image_fetch_failed|rate_capped|harness_error|worker_error|currency_mismatch|ali_price_unparseable|image_url_disallowed|no_store_price)/;

// Deterministic split, so re-running never reshuffles what counts as held-out.
const half = (id) => (md5(id).charCodeAt(0) % 2 === 0 ? 'tune' : 'holdout');

// Two producers, two shapes:
//   worker  (__alibadgeLabelset) — already ran the real decide(); rows carry `render`
//   browser (raw candidate harvest) — rows carry `cands`, decide() runs here
// The worker shape is the one that can actually be produced (bun and page context
// both get rate-punished), so it is the primary path.
const scored = rows.map((r) => {
  if (r.render) {
    return {
      id: r.id, bucket: r.bucket, half: half(r.id), fp: (r.fp || []).length > 0,
      outcome: r.reasons && r.reasons.length ? r.reasons[0] : 'ok',
      render: r.render, reasons: r.reasons || [], note: r.note || null,
      storePrice: r.price, storeCur: r.currency,
      aliPrice: r.aliPrice ?? null, aliCur: r.aliCurrency ?? null, aliTitle: r.aliTitle ?? null,
      ratio: r.aliPrice && r.aliCurrency === r.currency ? +(r.price / r.aliPrice).toFixed(2) : null,
      markup: r.markup ?? null,
      // "Comparable" = the pipeline got as far as an actual price-vs-price
      // comparison, which is the ONLY state in which the guards were exercised.
      // currency_mismatch belongs here, not with the passes: decide() refuses before
      // any guard runs, so a bucket full of them proves nothing about false
      // positives while reporting a perfect 0. That was the first version's bug.
      plumbed: !(r.reasons || []).some((x) => NOT_COMPARABLE.test(x)),
    };
  }
  const extraction = {
    url: `https://${r.host}/products/x`, host: r.host, title: r.title,
    vendor: r.vendor, price: r.price, currency: r.currency, image: r.image,
  };
  const cands = (r.cands || []).map((c) => ({ ...c }));
  const v = cands.length ? decide(extraction, cands, null)
    : { render: 'link-only', reasons: [r.outcome || 'no_results'], winner: null };
  const ali = v.winner ? parsePrice(v.winner.price) : null;
  return {
    id: r.id, bucket: r.bucket, half: half(r.id), fp: (r.fp || []).length > 0,
    outcome: r.outcome,
    render: v.render, reasons: v.reasons || [], note: v.note || null,
    storePrice: r.price, storeCur: r.currency,
    aliPrice: ali, aliCur: v.winner ? v.winner.currency : null,
    aliTitle: v.winner ? v.winner.title : null,
    ratio: ali && v.winner && v.winner.currency === r.currency ? +(r.price / ali).toFixed(2) : null,
    plumbed: (r.n ?? 0) > 0 && !(v.reasons || []).some((x) => NOT_COMPARABLE.test(x)),
  };
});

await Bun.write('labelset/scored.json', JSON.stringify(scored, null, 2));

const BUCKETS = ['dropship', 'easy_neg', 'hard_neg'];
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');

function report(rowsIn, label) {
  console.log(`\n=== ${label} (n=${rowsIn.length}) ===`);
  console.log('bucket     n   full  link  none   comparable');
  for (const b of BUCKETS) {
    const g = rowsIn.filter((r) => r.bucket === b);
    if (!g.length) continue;
    const full = g.filter((r) => r.render === 'full').length;
    const link = g.filter((r) => r.render === 'link-only').length;
    const none = g.filter((r) => r.render === 'none').length;
    const plumb = g.filter((r) => r.plumbed).length;
    console.log(`${b.padEnd(10)} ${String(g.length).padStart(2)}  ${String(full).padStart(4)}  ` +
      `${String(link).padStart(4)}  ${String(none).padStart(4)}   ${plumb}/${g.length} ${pct(plumb, g.length)}`);
  }
  // The number the success criteria actually turn on.
  const hn = rowsIn.filter((r) => r.bucket === 'hard_neg');
  const en = rowsIn.filter((r) => r.bucket === 'easy_neg');
  const dp = rowsIn.filter((r) => r.bucket === 'dropship');
  // A bucket that never got results cannot produce a false positive, so "0 false
  // positives" on unplumbed negatives is not a pass — it is an absence of evidence
  // that READS like a pass. That is the single most dangerous output this script
  // could print, so it refuses to print the number at all below the threshold.
  const MIN_PLUMB = 0.7;
  const rate = (g) => (g.length ? g.filter((r) => r.plumbed).length / g.length : 0);

  console.log(`\n  FALSE POSITIVES (a full badge on a negative):`);
  for (const [name, g] of [['hard negatives', hn], ['easy negatives', en]]) {
    const p = rate(g);
    const primary = name.startsWith('hard') ? '  <- primary criterion, must be 0' : '';
    if (!g.length) { console.log(`    ${name}: (none in this slice)`); continue; }
    if (p < MIN_PLUMB) {
      console.log(`    ${name}: INVALID — only ${Math.round(p * 100)}% of this bucket got ` +
        `results (need ${MIN_PLUMB * 100}%). Quiet for lack of data, not because a guard fired.`);
    } else {
      console.log(`    ${name}: ${g.filter((r) => r.render === 'full').length}/${g.length}${primary}`);
    }
  }
  const dpRate = rate(dp);
  if (dp.length && dpRate < MIN_PLUMB) {
    console.log(`  TRUE POSITIVES: INVALID — only ${Math.round(dpRate * 100)}% of the dropship ` +
      `bucket got results, so a low count measures the network, not the matcher.`);
  } else {
    console.log(`  TRUE POSITIVES: ${dp.filter((r) => r.render === 'full').length}/${dp.length} dropship items badged`);
  }

  const overall = rate(rowsIn);
  if (overall < MIN_PLUMB) {
    console.log(`\n  *** RUN NOT USABLE: ${Math.round(overall * 100)}% plumbing overall. ***`);
    console.log('  Re-run when the endpoint is not punishing. Do not tune against this.');
  }
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
