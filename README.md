# AliBadge

Chrome extension. On a Shopify product page, shows the AliExpress price of the same
product and the markup — without being asked.

MIT licensed. The measured results in `labelset/` are part of the repository on purpose:
they name the stores and brands the tool got RIGHT and the ones it got WRONG, including
four false accusations against Spigen and four against OtterBox that the first version
would have published. A tool that prints an accusation should show its error rate.

## Install

**Not a developer?** → **[INSTALL.md](INSTALL.md)** walks through it step by step, about two
minutes, no terminal. Download the zip from
[the latest release](https://github.com/navotvolkgroundup/alibadge/releases/latest).

Developers: `chrome://extensions` → Developer mode → **Load unpacked** → this directory.
The options page opens; **nothing is uploaded until you enable it there.** Then visit
`warmlydecor.com/products/caleb-modern-cutlery-set`.

`./build.sh` runs both suites and produces `dist/alibadge-<version>.zip` — only what the
extension runs, no tests and no `labelset/`.

**It is silent on most pages by design.** Measured on 40 products it showed a number on 2
of them. That is the point, not a fault: a percentage is close to an accusation, so it
requires a near-exact photo match AND importer fingerprints in the store.

## Two independent things must hold before a NUMBER appears

Either one alone is not enough, and this is the whole safety design:

1. **The photograph must match** — dHash distance ≤ 10 against the marketplace listing.
2. **The store must carry importer plumbing** — DSers/CJ/Inspire-Uplift SKU and filename
   shapes, from `importerSignature()`.

(2) exists because (1) is symmetric. A hash proves two photos are the same image; it
cannot say who copied whom, and AliExpress sellers routinely lift brand photography.
MEASURED: all four Misen carbon-steel pans passed the hash gate at 5-10 bits and were
stopped only by the price floor. Requiring importer plumbing closes that and costs
nothing on the labelled set — both measured true positives carry DSers signatures.

Without (2) the badge still links to the search. It just never states a percentage.

Debug logging: `chrome.storage.local.set({ alibadgeDebug: true })` from the extension's
service-worker console, then reload the page. Silence is the default state, so this is
the only way to tell a working extension from a broken one.

## Layout

```
manifest.json      MV3. host_permissions *://*/* (worker must fetch Shopify + alicdn CDNs)
src/lib.js         pure functions — every path that can produce a WRONG NUMBER
src/lib.test.js    bun test, 27 cases
src/worker.js      all network + all chrome.* ; the two AliExpress calls
src/content.js     extract, render, teardown, dismiss. No imports (content scripts can't)
src/receipt.js     the shareable PNG, drawn on a canvas. Loaded BEFORE content.js so they
                   share the isolated world's scope
test/e2e.spec.js   playwright: real page → real decide() → real badge, no network
preview.html       receipt design harness (see below)
smoke.js           runs the worker pipeline outside Chrome: bun smoke.js
labelset/          premise-2 measurement: probe.js builds the set, the worker runs it,
                   score.js grades it. See "Measuring premise 2" below
```

`bun test src` for the logic (33 cases — scope it to `src`, or it globs the Playwright spec). `bunx playwright test` for extraction → `decide()` →
badge in a real browser with no network: `page.route` serves the fixtures and `decide()`
is called through an exposed binding, so the policy is the real one rather than a stub.
The hard-negative case asserts `reasons` contains `ratio_implausible` — a DOM-absence
assertion alone would pass with `brandGuard` deleted.

`bun smoke.js` for the live pipeline. For the receipt design:

```
python3 -m http.server 8777   # then open http://127.0.0.1:8777/preview.html
```

`preview.html` renders `receipt.js` with real measured data against both a light and a
dark timeline, so the composition can be iterated without reloading the extension.

## Verified pipeline

1. **Extract** — `/products/<handle>.js` with `credentials: same-origin` (Shopify Markets
   currency is cookie-driven), variant-aware, `price` never `compare_at_price`, then
   cross-checked against the price text visible in the DOM.
2. **Upload** — MTOP `mtop.relationrecommend.AliexpressRecommend.recommend`, appId 21738,
   appKey 24815441, on `recom-acs.aliexpress.com`. Returns a `fileId`.
3. **Results** — `POST /fn/search-pc/index` with `{isNewImageSearch:"y", filename:<fileId>}`.
   Returns **60** items at `data.data.root.fields.mods.itemList.content`. Needs no cookies.
4. **Hash gate** — dHash 9x8 of the store photo against the top 8 candidates' originals,
   `distance <= 10` to pass. Rank alone cannot tell "the same photograph" from "the same
   category": MEASURED ungated, the labelled run gave 7 badges of which **4 were false
   accusations against Spigen**; gated, 1 badge and 0 false. Distances are stored on the
   cached results, not pass/fail, so a threshold change applies without re-fetching.
5. **Dearest variant** — ONE `pdp.pc.query` for the winner only, before the cache write,
   so a cache hit never re-issues it. Verified working inside the extension; returns null
   on a punish and the badge degrades to the bound rather than disappearing.
   `self.__alibadgePdp('<productId>')` dumps the payload shape if it ever moves.
6. **Currency** — `withStoreCurrency()` sets the `aep_usuc_f` cookie to the store's
   currency around the results call, so all 60 candidates arrive already comparable, then
   restores whatever the user had. No FX rate exists anywhere in this extension.
7. **Decide** — `decide()` owns the render policy and returns all failing reasons.

Verified live end-to-end on 2026-07-26: handshake → 180,488-char base64 upload → 60 items
with prices and sold counts.

## Things that will bite you

- **`type:"POST"`, not `method:"POST"`** in AliExpress's own JS client. The default
  jsonp/GET transport puts the payload in the query string and caps it near **8 KB of
  base64** — which silently downscales the image and wrecks match quality. From this
  worker it's a real POST, which is why full-size images work.
- **The MTOP handshake is required**, including on `recom-acs`. First call returns
  `FAIL_SYS_TOKEN_EMPTY` and sets `_m_h5_tk`; the token is the part before the `_`.
  Reading that cookie is why the `cookies` permission exists.
- **`/fn/search-pc/index` rate-punishes.** It returns **HTTP 200 with an HTML redirect
  to `_____tmd_____/punish`**, so status alone never reveals it. Measured from a
  non-browser client: worked once, then punished on every retry. From a real browser page
  context it has been reliable. Whether Chrome's own network stack in the worker behaves
  like the browser or like the script is **the open question** — `reasons: ['punished']`
  exists to tell you.
- **The results currency is a COOKIE, not a parameter.** `aep_usuc_f` with `c_tp=USD`
  makes `/fn/search-pc/index` return USD; without it, geo currency (ILS from Israel).
  Measured on one `fileId` back to back, 60 items each way. The request therefore uses
  `credentials: 'include'` — switching it to `omit` silently reverts to geo currency
  and every USD store degrades to `currency_mismatch`. `withStoreCurrency()` restores
  the user's own cookie afterwards, since it drives the currency they see on the site.
- **`pdp.pc.query` works from the extension, and only from there.** Measured: `SUCCESS`,
  ~74KB, and no MTOP handshake needed because the cookie is already present. From bun the
  same request is punished on the FIRST call (`FAIL_SYS_USER_VALIDATE`), so that punish
  was about the client, not the endpoint. It is not a currency fix — the cookie is — it
  is the only source of the DEAREST variant.
- **Two traps inside `skuPriceInfoMap`.** `salePriceLocal` is `"$9.80|9|80"`; feeding it
  to `parsePrice` returns **80**, a 10x overstatement in the accusing direction. And
  `originalPrice` is the struck-through figure. Only `salePriceString` is safe, and
  `dearestFromSkuMap()` in lib.js is tested against a verbatim live entry for both.
- **The gate must FAIL CLOSED.** `gateFromStored()` never returns null. It used to, when
  no candidate carried a distance, and `decide()` then fell back to AliExpress's rank —
  ungated — in exactly the two cases where the gate matters most: the store image failing
  to hash, and every candidate image fetch failing. Note `JSON.stringify(Infinity)` is
  `"null"`, so a cache round-trip erased every distance on its own. An ad blocker is
  enough to trigger it, since candidate images come from `aliexpress-media.com`.
  MEASURED: i-cell.co.il rendered +570% against a licensed Otterbox whose closest gallery
  image is **21 bits** away. No distance now means no pass.
- **Hash the ORIGINAL alicdn image, not the thumbnail.** Result images arrive as
  `...jpg_220x220q75.jpg_.webp`; a padded 220px thumbnail scores far from a full-size
  store photo even when the two are the same image. `stripAlicdnSize()` exists for this.
- **Large images silently fail the upload.** No `fileId`, no error. Measured: Stanley
  7.0MB PNG, Otterbox 1.9MB, Anker 870KB all failed; Spigen's 70KB JPEG worked. That
  cost 9 of 16 hard negatives in the labelled run — most of the bucket the primary
  success criterion depends on — and it read as a property of those stores rather than
  a payload limit. `encodeForUpload()` downscales to 1200px / 400KB JPEG first.
- **`fileId`s expire quickly.** Minutes. Don't cache one and reuse it later.
- **Never scrape the results DOM** — it renders 12 of the 60 items the API returns.
- **`salePrice`, never `originalPrice`** — originalPrice is the struck-through figure and
  inflates markup, exactly like `compare_at_price` store-side.
- **The results payload has no dearest-variant price.** Dumped 2026-07-27 across 60
  items: `salePrice.minPrice` and nothing else — no max, no `skuPriceInfoMap`, and
  `formattedPrice` is never a range, so `parsePrice`'s range-max path never fires here.
  The dearest variant comes from `pdp.pc.query` instead — measured on 32930388619: 24
  skus spanning \$6.28 to \$9.80. When that call fails the markup is an **upper bound**
  and the receipt says so. **The basis string is DERIVED from the winner, never hardcoded** — a constant
  is exactly what let the receipt print "dearest variant" for a whole period after the
  code producing dearest prices was deleted. There is a Playwright test on this.
- **Reloading the extension does NOT reload content scripts in open tabs.** The old
  script keeps running with the old code and its already-computed verdict. This produced
  a receipt with a caveat the shipped logic cannot generate, a basis string deleted two
  commits earlier, and the previous day's capture date — all genuine output from code
  that no longer existed. `onInstalled` stamps `updatedAt`; a content script injected
  before that warns and disables the receipt button. **Reload the PAGE, not just the
  extension.**
- **Don't add the `tabs` permission.** `changeInfo.url` is populated already because
  `host_permissions` covers the tab.
- **Don't patch `history.pushState` from the content script.** The isolated world has its
  own `history`, so the patch never intercepts the page, and `replaceState` (which Shopify
  variant switching uses) never fires `popstate`.
- **Brand signals are NOTES, not guards.** Both `vendorMismatch()` (the store declares
  `product.vendor: Otterbox`, the listing never says Otterbox) and `knownBrandIn()`
  (the store title contains a known mark) render the number and print a caveat beside
  it. Suppression was tried on both and thrown out: it discards a true find — the same
  item, far cheaper — to avoid an assertion the caveat already prevents. `note` travels
  onto the receipt for the same reason: the artifact is what gets posted, at 14px in
  the accent colour — a timeline scales the PNG down, and an illegible qualifier is
  not a qualifier. It does not displace `excludes shipping`, which is separate.
- **A store's own name is often its `vendor`.** i-cell.co.il publishes `vendor: iCell`
  and two ld+json `brand.name: iCell` entries — no Otterbox anywhere, even though the
  title says it. So `vendorMismatch` compares on alphanumerics only (`icell` vs
  `i-cell`, which a raw substring test misses in both directions), and the brand token
  list is what actually catches that page.
- **Only two things still silence the badge:** `ratio_implausible` (a gap that large on
  a price that high means the MATCH is wrong, not that the markup is big) and
  `price_dispersion`. Both say the comparison itself is unsound, which no caveat fixes.
- **The brand-guard ceiling is conditional on absolute price.** A $2 item at 36× is
  ordinary dropshipping; a $200 item at 36× suggests a counterfeit. An unconditioned 15×
  ceiling suppresses the genuine dropshippers this exists to find.

## Not built yet

- **Per-variant price table on the receipt.** The approved mockup has one; the results API
  returns a single price per listing, so there is no variant data to render. Omitted rather
  than invented, per the doc's own rule. Add it if the PDP lookup lands (it returns a full
  `skuPriceInfoMap`).
- **Design tokens.** Currently a monospace stack in the badge CSS. The doc calls for a
  named display face with tabular numerals — deliberately not `system-ui`.

## Measuring premise 2

The labelled set is three buckets — `dropship` (expected true positives), `easy_neg`
(real brands with no plausible AliExpress presence) and `hard_neg` (real brands **with**
known AliExpress counterfeits). The third is the point: without it the false-positive
number only measures the easy case.

```
bun labelset/probe.js          # candidates -> probed.json (free, no AliExpress calls)
bun labelset/build.js          # probed.json -> set.json, the file the extension loads
python3 labelset/serve.py      # serves the set, receives harvested verdicts
```

Then, from **the extension's service-worker console** — the "service worker" link on
`chrome://extensions`, NOT the page console; `self.__alibadgeLabelset` does not exist
in a page:

```
await self.__alibadgeLabelset()
```

**`Uncaught Error: No SW` means Chrome killed the idle worker** (the card reads
"service worker (Inactive)"). Load any Shopify product page to wake it, then re-open
the inspector. The run is resumable for the same reason: every row is written to
`chrome.storage` as it completes, so a restart costs one item, and re-running continues
from where it stopped. `__alibadgeLabelsetDump()` prints what has accumulated;
`__alibadgeLabelset(null, true)` starts over and clears the result cache.

The set is bundled at `labelset/set.json` and loaded via `chrome.runtime.getURL`, so
this needs no server.

```
bun labelset/score.js labelset/harvest.json   # if the POST worked
pbpaste | bun labelset/score.js -             # otherwise, from the logged JSON
```

**Why it cannot run from bun.** `labelset/run.js` is the bun version and it does work —
for about three items. Then `/fn/search-pc/index` rate-punishes every retry, and
`mtop.aliexpress.pdp.pc.query` is punished on the *first* call
(`FAIL_SYS_USER_VALIDATE` → `_____tmd_____/punish`). Inside a loaded extension both
calls work. `run.js` is kept because it is the fastest way to check the plumbing, not
because it can produce the number.

**The scorer refuses to grade an unusable run.** A bucket that never reached a
price-vs-price comparison cannot produce a false positive, so "0 false positives"
there is an absence of evidence that reads like a pass. `currency_mismatch` counts as
not-comparable for exactly this reason — `decide()` refuses before any guard runs.
Below 70% comparable, the number is replaced by `INVALID`.

`probe.js` also fingerprints each store for importer signatures (DSers SKU shapes,
`product-image-<digits>` filenames, `My Store` vendor). That is the unbiased labeller
the design doc asks for — it keys on SKU and filename shape, independent of photo
reuse, so it does not select the test set on the very thing being measured.
