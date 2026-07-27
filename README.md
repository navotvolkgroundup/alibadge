# AliBadge

Chrome extension. On a Shopify product page, shows the AliExpress price of the same
product and the markup — without being asked.

Design doc: `~/.gstack/projects/navotvolkgroundup-nabot/navotv-main-design-20260725-141510.md`

## Install (v1 is load-unpacked by design)

1. `chrome://extensions` → enable Developer mode
2. **Load unpacked** → select this directory
3. Visit a Shopify product page (try `warmlydecor.com`)

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
4. **Re-price** — the results endpoint returns whatever currency the caller's geo implies,
   so the top 3 candidates go through `mtop.aliexpress.pdp.pc.query` (appKey 12574478, on
   `acs.aliexpress.com`, its own handshake), which honours `_currency` per call. Takes the
   DEAREST variant: the cheapest inflates the ratio, and measured it flipped 3 of 10 verdicts.
5. **Decide** — `decide()` owns the render policy and returns all failing reasons.

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
- **`fileId`s expire quickly.** Minutes. Don't cache one and reuse it later.
- **Never scrape the results DOM** — it renders 12 of the 60 items the API returns.
- **`salePrice`, never `originalPrice`** — originalPrice is the struck-through figure and
  inflates markup, exactly like `compare_at_price` store-side.
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
- **Perceptual hash gate (blockhash).** `decide()` takes a `gate` argument and currently
  gets `null`, falling back to AliExpress's own result rank — which is itself a visual
  similarity signal, with the brand guard and markup floor still gating. Add blockhash
  when rank measurably admits wrong matches.
- **Design tokens.** Currently a monospace stack in the badge CSS. The doc calls for a
  named display face with tabular numerals — deliberately not `system-ui`.

## Measuring premise 2

The labelled set is three buckets — `dropship` (expected true positives), `easy_neg`
(real brands with no plausible AliExpress presence) and `hard_neg` (real brands **with**
known AliExpress counterfeits). The third is the point: without it the false-positive
number only measures the easy case.

```
bun labelset/probe.js          # candidates -> probed.json (free, no AliExpress calls)
python3 labelset/serve.py      # serves the set, receives harvested verdicts
```

Then, from **the extension's service-worker console** — the "service worker" link on
`chrome://extensions`, NOT the page console; `self.__alibadgeLabelset` does not exist
in a page:

```
await self.__alibadgeLabelset()
```

The set is bundled at `labelset/set.json` and loaded via `chrome.runtime.getURL`, so
this needs no server. It logs `[labelset] 44 items loaded` immediately, a line per
item, and the full JSON at the end. If `serve.py` is running it also POSTs progress
after every item, which is convenient but never load-bearing.

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

**A consequence worth knowing:** because pdp.pc.query never answered outside the
extension, the dearest-variant re-price in `worker.js` is **unverified**. The live
badge that appeared to prove it was a case where store and results were both ILS, so
no conversion happened. `repriced 0/3` in the worker console means it is still failing.

`probe.js` also fingerprints each store for importer signatures (DSers SKU shapes,
`product-image-<digits>` filenames, `My Store` vendor). That is the unbiased labeller
the design doc asks for — it keys on SKU and filename shape, independent of photo
reuse, so it does not select the test set on the very thing being measured.
