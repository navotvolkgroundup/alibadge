# Chrome Web Store listing — paste-ready

Every field the dashboard asks for, in dashboard order. Assets in `dist/store/`.

---

## Product details

**Category:** `Shopping`
**Language:** `English (United States)`

**Description** (paste as-is; leads with what it does, then what it refuses to claim —
which is also what stops a reviewer treating it as an accusation tool):

```
AliBadge tells you when a store is reselling an AliExpress listing, and what the markup is.

On a Shopify product page it searches AliExpress by the product photo. When it finds the
same photograph on a marketplace listing, it shows the price difference and a link to that
listing so you can check for yourself.

WHAT MAKES IT DIFFERENT

It is silent far more often than it speaks, on purpose. Showing a percentage is an
accusation, so two independent things must both be true before AliBadge shows one:

1. The photograph must be a near-exact match — not merely a similar-looking product.
2. The store must carry dropship importer plumbing — the SKU and image-filename shapes
   that DSers, CJdropshipping and Inspire Uplift leave behind.

The second check exists because the first cannot tell you who copied whom. Marketplace
sellers steal brand photography all the time, and a matching photo alone would accuse the
brand. When only the photo matches, you get a link and no number.

MEASURED, NOT ASSUMED

On a 40-product labelled set covering dropship stores, ordinary brands, and brands with
known marketplace counterfeits (Stanley, Spigen, OtterBox, Anker):

• 0 false positives across all 32 legitimate-brand products
• 2 of 8 dropship products detected

Low recall is the deliberate trade. Most product pages will show you nothing.

HOW THE NUMBER IS CALCULATED

• Compared against the DEAREST variant of the matched listing, not the cheapest — the
  conservative end, so the markup is understated rather than inflated.
• Store price is the current selling price, never a struck-through "was" price.
• Both sides are converted to the store's own currency. Shipping is excluded and the
  receipt says so.

THE RECEIPT

One click copies a shareable image: both photographs side by side, both prices, the
difference, and the full marketplace URL so anyone can reproduce it.

PRIVACY

Nothing is uploaded until you enable it — the options page opens on install and explains
exactly what gets sent. AliBadge sends the product photo of Shopify product pages you
visit to AliExpress in order to search. It sends nothing anywhere else. There is no
AliBadge server, no analytics, and no account.

WHAT IT IS NOT

Not a counterfeit detector. Not a verdict about any merchant. It reports a photo match and
a price difference, and shows you where to check.
```

---

## Graphic assets

| Field | File |
|---|---|
| Store icon, 128×128 | `icons/icon128.png` |
| Screenshot 1, 1280×800 | `dist/store/01-receipt.png` |
| Screenshot 2, 1280×800 | `dist/store/02-consent.png` |
| Screenshot 3 | **take this one yourself** — see below |

Screenshot 3 should be the badge on a live page, because it is the only asset that would
be a misrepresentation if I mocked it. Open
`warmlydecor.com/products/caleb-modern-cutlery-set` in a 1280×800 window with the badge
showing `+305%` and capture it.

Small promo tile (440×280) is optional; skip it.

---

## Privacy tab

**Single purpose** (this is the field reviewers weigh most):

```
AliBadge has one purpose: on a product page, identify whether the same product photograph
appears on an AliExpress listing, and if so show the price difference between the two.
```

**Permission justifications** — one per permission the manifest requests:

| Permission | Justification |
|---|---|
| `host permissions` (`*://*/*`) | The extension cannot know in advance which sites are Shopify stores, so it must be able to run on a page to determine whether that page is a product page at all. On pages that are not Shopify product pages it stops immediately and does nothing. It reads only the product JSON the store already publishes at /products/<handle>.js. |
| `storage` | Stores the user's consent flag, a 7-day cache of marketplace search results keyed by image hash (which reduces repeat uploads), and the list of stores the user has muted. Local to the browser. |
| `cookies` | Reads one AliExpress cookie (`_m_h5_tk`), a handshake token their API requires, and temporarily sets AliExpress's own currency cookie (`aep_usuc_f`) so returned prices are in the store's currency, restoring the previous value afterwards. Only AliExpress cookies are accessed. |
| `clipboardWrite` | Copies the comparison image to the clipboard when the user clicks "copy receipt". |
| `declarativeNetRequestWithHostAccess` | AliExpress's search endpoint rejects requests carrying a `chrome-extension://` Origin with HTTP 403. One static rule rewrites the Origin and Referer headers on requests to that endpoint only. |
| Remote code | **No.** All code is in the package. Nothing is fetched and executed. |

**Data usage** — tick only:

- [x] **Website content** — the product image of Shopify product pages, transmitted to
  AliExpress for reverse image search.

Leave unticked: PII, health, financial, authentication, personal communications, location,
web history, user activity.

Then all three certifications:

- [x] Not being sold to third parties, outside of approved use cases
- [x] Not being used or transferred for purposes unrelated to the item's single purpose
- [x] Not being used or transferred to determine creditworthiness or for lending purposes

**Privacy policy URL** — required, and must be publicly reachable. `PRIVACY.md` is written;
it needs hosting. Fastest route:

```bash
gh gist create PRIVACY.md --public --desc "AliBadge privacy policy"
```

Or push the repo public and use the raw file URL.

---

## Distribution

- **Visibility:** `Unlisted` for the first submission. It still goes through full review, it
  is installable by link, and it will not collect ratings from strangers while recall is
  2 of 8.
- **Regions:** all.

---

## Expect a manual review, and expect it to be slow

`*://*/*` plus "transmits website content to a third party in China" is the combination
that draws human eyes. Two things that help, both already true: the single-purpose
statement matches what the code does, and the consent gate means the extension transmits
nothing on a fresh install until the user acts.

If it is rejected, the likely citation is broad host permissions. The honest answer is that
the narrower alternative — `activeTab` plus a click — removes the zero-click behaviour that
is the point of the product. That is a real trade, not a workaround to find.
