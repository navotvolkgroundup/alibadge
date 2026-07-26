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
preview.html       receipt design harness (see below)
smoke.js           runs the worker pipeline outside Chrome: bun smoke.js
```

`bun test` for the logic. `bun smoke.js` for the live pipeline. For the receipt design:

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
4. **Decide** — `decide()` owns the render policy and returns all failing reasons.

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
- **The brand-guard ceiling is conditional on absolute price.** A $2 item at 36× is
  ordinary dropshipping; a $200 item at 36× suggests a counterfeit. An unconditioned 15×
  ceiling suppresses the genuine dropshippers this exists to find.

## Not built yet

- **Per-variant price table on the receipt.** The approved mockup has one; the results API
  returns a single price per listing, so there is no variant data to render. Omitted rather
  than invented, per the doc's own rule. Add it if the PDP lookup lands (it returns a full
  `skuPriceInfoMap`).
- **Conservative variant pricing.** The receipt prints `based on matched listing, lowest
  variant` because `salePrice.minPrice` is the cheapest variant, which INFLATES the markup.
  The doc calls the dearest variant the conservative choice, and measured it flipped 3 of 10
  verdicts. `smoke.js` shows the fix via `mtop.aliexpress.pdp.pc.query`. **This is the most
  important open correctness item.**
- **Perceptual hash gate (blockhash).** `decide()` takes a `gate` argument and currently
  gets `null`, falling back to AliExpress's own result rank — which is itself a visual
  similarity signal, with the brand guard and markup floor still gating. Add blockhash
  when rank measurably admits wrong matches.
- **Currency normalisation across sources.** The results endpoint returns whatever
  currency the caller's geo implies, so a USD store against ILS results correctly
  degrades to link-only. `smoke.js` shows the fix: resolve the winner's price via
  `mtop.aliexpress.pdp.pc.query`, which honours `_currency` per call.
- **Playwright E2E**, both cases from the design doc — badge fires on a dropship fixture,
  and a hard-negative fixture asserting `decide().reasons` contains `brand_guard`. A
  DOM-absence assertion would pass with the guard deleted, so it must assert the reason.
- **Design tokens.** Currently a monospace stack in the badge CSS. The doc calls for a
  named display face with tabular numerals — deliberately not `system-ui`.
