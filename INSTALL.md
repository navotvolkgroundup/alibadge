# Installing AliBadge

No technical knowledge needed. Takes about two minutes.

AliBadge is not in the Chrome Web Store yet, so you install it from a file. Chrome calls
this a "developer mode" install. It works fine, but Chrome will show you a couple of
warnings along the way — that is normal and the steps below tell you when to expect them.

**Works with:** Chrome, Edge, Brave, Arc, and other Chromium browsers, on Mac or Windows.
Not Safari or Firefox.

---

## Step 1 — Download the file

Go to the [latest release](https://github.com/navotvolkgroundup/alibadge/releases/latest)
and click the file ending in **`.zip`** to download it.

## Step 2 — Unzip it, and put the folder somewhere permanent

Double-click the downloaded `.zip`. You get a folder called something like
`alibadge-0.2.0`.

**Move that folder somewhere you will not delete it** — your Documents folder is fine.
Chrome loads the extension from wherever this folder lives, so if you delete it or move it
later, the extension stops working. Don't leave it in Downloads.

## Step 3 — Open Chrome's extensions page

Copy this, paste it into Chrome's address bar, and press Enter:

```
chrome://extensions
```

(Clicking a `chrome://` link does not work — it has to be pasted.)

## Step 4 — Turn on Developer mode

Top right of that page, there is a switch labelled **Developer mode**. Turn it on.

Three buttons appear at the top left: *Load unpacked*, *Pack extension*, *Update*.

## Step 5 — Load the folder

Click **Load unpacked**, then choose the folder you unzipped in Step 2.

Pick the folder itself — the one containing `manifest.json`. Do not go inside it, and do
not select the `.zip`.

AliBadge should now appear in your list of extensions.

## Step 6 — Turn it on

A page opens by itself explaining what the extension sends and where. Read it, then tick
**Enable price comparison**.

**Nothing happens until you tick that box.** AliBadge uploads no data at all before you
give permission.

## Step 7 — Try it

Visit this page:

```
https://warmlydecor.com/products/caleb-modern-cutlery-set
```

Within a few seconds a small dark badge appears in the bottom-left corner showing
**+305%**. Click **on AliExpress** to see the listing it matched.

If you see that, it is working.

---

## What to expect day to day

**Most product pages will show you nothing.** This is the single most important thing to
understand, and it is deliberate, not a fault.

AliBadge only shows a percentage when it is confident on two separate counts: the product
photo is a near-exact match for a marketplace listing, *and* the store shows the technical
fingerprints of a dropshipping importer. On a 40-product test it stayed silent on 38 of
them. Showing a markup is close to an accusation, so it stays quiet unless the evidence is
strong.

Sometimes you get a badge with a **link but no percentage**. That means it found something
worth a look but is not confident enough to put a number on it.

**Two warnings from Chrome are normal:**

- Chrome may show "Disable developer mode extensions" each time you start it. Click the X.
  It appears for any extension installed this way and does not indicate a problem.
- Chrome may warn about the extension reading data on all sites. It needs to check whether
  a page is a store product page. It reads the product information the store already
  publishes and nothing else. Full detail in [PRIVACY.md](PRIVACY.md).

---

## Troubleshooting

**No badge on the test page above.** Check the extension is enabled at
`chrome://extensions`, and that you ticked the box in Step 6. Then reload the page.

**Still nothing.** If you use an ad blocker, it may be blocking the marketplace's image
server, and AliBadge stays silent rather than guessing. Try the test page with the ad
blocker paused for that site.

**It worked and then stopped.** You probably moved or deleted the folder from Step 2. Put
it back, or repeat Steps 3–5.

**The badge is in the way.** Click the small × to dismiss it, or **mute this store** to
silence it on that site permanently.

**I want it off.** Go to `chrome://extensions`, find AliBadge, and either use the toggle to
disable it or click **Remove** to uninstall. Untick the box on its options page and it
deletes everything it had saved.

---

## For developers

`git clone` and **Load unpacked** on the repository directory works identically — the
release `.zip` is only that directory with the tests and measurement data removed.

There is no `.crx` download on purpose. Chrome has refused to install `.crx` files from
outside the Web Store since Chrome 33, so a `.crx` would be a file nobody can use.

`./build.sh` runs both test suites and produces the release zip.
