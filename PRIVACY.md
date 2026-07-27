# AliBadge — privacy

Last updated 2026-07-27. Applies to version 0.2.0.

## The short version

AliBadge sends the **product photo** of Shopify product pages you visit to **AliExpress**
(Alibaba Group, China) in order to search for a visually identical listing. It sends
nothing anywhere else. There is no AliBadge server.

**Nothing is uploaded until you enable it** on the extension's options page, which opens
by itself on install.

## What is collected

Nothing is collected by the author. There is no backend, no analytics, no telemetry, no
crash reporting and no identifier of any kind.

## What is transmitted, and to whom

| Data | Recipient | Why |
|---|---|---|
| The product photo of a Shopify product page you visit (downscaled to 1200px) | AliExpress | Reverse image search |
| A product id from the search results | AliExpress | Fetch that listing's per-variant prices |

Requests carry no account, no sign-in and no AliBadge identifier. AliExpress will see them
as it sees any request from your browser, subject to its own privacy policy.

Not transmitted: page text, page URLs, browsing history, cookies, form data, personal
details, or anything from non-Shopify pages.

## What is stored, and where

In your browser only, via `chrome.storage.local`:

- Your consent flag.
- Search results, keyed by a hash of the image bytes, for 7 days. Reduces repeat uploads.
- Any store you have muted.

Disabling the extension on the options page deletes the cached results immediately.
Uninstalling removes everything.

## Permissions, and why each is needed

- `*://*/*` (host access) — the extension cannot know in advance which sites are Shopify
  stores, so it must be able to run on a page to decide whether to do anything. It reads
  the product JSON the store already publishes and nothing else.
- `storage` — the consent flag and the cache above.
- `cookies` — reads one AliExpress handshake token (`_m_h5_tk`) required by their API, and
  temporarily sets AliExpress's own currency cookie so prices come back in the store's
  currency. Both are AliExpress cookies. No other site's cookies are read.
- `clipboardWrite` — copies the receipt image when you click the button.
- `declarativeNetRequestWithHostAccess` — rewrites the `Origin` header on requests to
  AliExpress, which rejects extension origins outright.

## Not sold, not shared

No data is sold, rented, shared, or transferred to anyone. There is nobody to transfer it
to.

## Contact

Open an issue on the repository.
