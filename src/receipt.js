// Receipt PNG composition. Runs in the content script's isolated world (listed
// before content.js in the manifest, so it shares that scope).
//
// Design source: designs/alibadge-receipt-20260726/remix/variant-B.png
//
// Two rules from the design review govern everything here:
//
// 1. ASYMMETRY. The store has exactly ONE price; the marketplace has MANY. Any
//    layout that presents them as a symmetric table invents data — proven, when a
//    symmetric brief made an image generator fabricate a whole store-price column
//    with $0.00 differences on rows where the store sells nothing.
//
// 2. RENDER ONLY MEASURED FIELDS, OMIT RATHER THAN ESTIMATE. The receipt genre has
//    slots and slots invite invention; across five generated mockups the generator
//    fabricated a review count, a returns policy, and a "secure checkout" badge.
//    On an artifact that names a real merchant, every unverified field is a
//    liability. So: no per-variant table (the API gives one price per listing), no
//    star rating unless present, no certification seal, and a neutral headline.
var AliBadgeReceipt = (() => {
  const W = 1200, H = 675, S = 2; // 2x for a crisp timeline image
  const PAD = 44;

  const C = {
    bg: '#12100e',
    border: '#3a352f',
    rule: '#2a2622',
    text: '#f6f4f1',
    muted: '#9b938b',
    dim: '#6f6862',
    accent: '#ff5a4d',
    panel: '#191614',
  };
  // Monospace by design: the whole artifact is aligned numbers, and it carries the
  // receipt genre for free. Explicitly not system-ui.
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const f = (size, weight = 'normal') => `${weight} ${size}px ${MONO}`;

  function loadImage(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      // Both CDNs send access-control-allow-origin: *, so this keeps the canvas
      // untainted and toBlob() usable.
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
      setTimeout(() => resolve(null), 8000);
    });
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function ellipsize(g, text, maxW) {
    let t = String(text || '');
    if (g.measureText(t).width <= maxW) return t;
    while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  // Draw an image cover-cropped into a box, or a labelled placeholder if it failed
  // to load. A missing thumbnail must never become a fabricated one.
  function drawThumb(g, img, x, y, size, label) {
    g.save();
    roundRect(g, x, y, size, size, 6);
    g.clip();
    if (img) {
      const s = Math.max(size / img.width, size / img.height);
      const dw = img.width * s, dh = img.height * s;
      g.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
    } else {
      g.fillStyle = C.panel;
      g.fillRect(x, y, size, size);
      g.fillStyle = C.dim;
      g.font = f(11);
      g.textAlign = 'center';
      g.fillText('image unavailable', x + size / 2, y + size / 2);
      g.textAlign = 'left';
    }
    g.restore();
    g.strokeStyle = C.border;
    g.lineWidth = 1;
    roundRect(g, x + 0.5, y + 0.5, size - 1, size - 1, 6);
    g.stroke();

    g.font = f(10, 'bold');
    g.fillStyle = C.muted;
    g.fillText(label.toUpperCase(), x, y - 8);
  }

  function money(n, currency) {
    if (!Number.isFinite(n)) return '—';
    const sym = { USD: '$', EUR: '€', GBP: '£', ILS: '₪' }[currency];
    const v = n.toFixed(2);
    return sym ? sym + v : `${v} ${currency || ''}`.trim();
  }

  /**
   * @param d {{
   *   storeHost, storeTitle, storePrice, currency, storeImage,
   *   aliTitle, aliPrice, aliImage, aliUrl, sold, markup,
   *   priceBasis, shipTo, capturedAt
   * }}
   * @returns {Promise<Blob|null>}
   */
  async function render(d) {
    const [storeImg, aliImg] = await Promise.all([loadImage(d.storeImage), loadImage(d.aliImage)]);

    const cv = document.createElement('canvas');
    cv.width = W * S;
    cv.height = H * S;
    const g = cv.getContext('2d');
    g.scale(S, S);
    g.textBaseline = 'alphabetic';

    // Opaque background + border: a fixed PNG cannot adapt, so it must read as a
    // deliberate card against both a white and a near-black timeline.
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = C.border;
    g.lineWidth = 2;
    g.strokeRect(1, 1, W - 2, H - 2);

    const rule = (yy) => {
      g.strokeStyle = C.rule;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(PAD, yy);
      g.lineTo(W - PAD, yy);
      g.stroke();
    };

    // --- header: neutral, no seal ---------------------------------------------
    g.font = f(26, 'bold');
    g.fillStyle = C.text;
    g.fillText('PRICE COMPARISON', PAD, PAD + 22);
    g.font = f(17, 'bold');
    g.textAlign = 'right';
    g.fillStyle = C.muted;
    g.fillText('AliBadge', W - PAD, PAD + 22);
    g.textAlign = 'left';
    rule(PAD + 44);

    // Two columns of equal height, so nothing can overflow into the row below.
    const TOP = PAD + 78;
    const COL_H = 296;
    const TH = 224;
    const leftW = TH * 2 + 26;

    // --- left: the photo-match evidence ---------------------------------------
    drawThumb(g, storeImg, PAD, TOP + 16, TH, d.storeHost || 'store');
    drawThumb(g, aliImg, PAD + TH + 26, TOP + 16, TH, 'aliexpress');

    let ty = TOP + 16 + TH + 30;
    g.font = f(13);
    g.fillStyle = C.muted;
    g.fillText(ellipsize(g, d.storeTitle, leftW), PAD, ty);
    ty += 22;
    g.fillStyle = C.dim;
    g.fillText(ellipsize(g, d.aliTitle, leftW), PAD, ty);

    // --- right: markup panel, basis printed not implied -----------------------
    const px = PAD + leftW + 34;
    const pw = W - PAD - px;
    g.fillStyle = C.panel;
    roundRect(g, px, TOP, pw, COL_H, 10);
    g.fill();
    g.strokeStyle = C.border;
    roundRect(g, px + 0.5, TOP + 0.5, pw - 1, COL_H - 1, 10);
    g.stroke();

    g.font = f(11, 'bold');
    g.fillStyle = C.muted;
    g.fillText('MARKUP', px + 20, TOP + 30);
    g.font = f(10);
    g.fillStyle = C.dim;
    g.fillText(
      ellipsize(g, 'based on ' + (d.priceBasis || 'matched listing'), pw - 40),
      px + 20, TOP + 48
    );

    const pct = Number.isFinite(d.markup) ? '+' + d.markup + '%' : '—';
    g.font = f(78, 'bold');
    g.fillStyle = C.accent;
    g.fillText(pct, px + 20, TOP + 146);

    if (Number.isFinite(d.markup) && d.aliPrice > 0) {
      g.font = f(26, 'bold');
      g.fillStyle = C.accent;
      g.fillText(Math.round((d.storePrice / d.aliPrice) * 10) / 10 + '×', px + 20, TOP + 190);
    }
    g.font = f(11);
    g.fillStyle = C.dim;
    g.fillText('excludes shipping', px + 20, TOP + COL_H - 20);

    // --- the three numbers: ONE store price, ONE compared price ---------------
    // Deliberately three cells, not rows per variant: the store has a single price
    // and inventing rows for it is exactly the failure this layout exists to avoid.
    let y = TOP + COL_H + 44;
    rule(y - 26);

    const cells = [
      ['STORE PRICE', money(d.storePrice, d.currency), C.text],
      ['ALIEXPRESS PRICE', money(d.aliPrice, d.currency), C.text],
      ['DIFFERENCE', money(d.storePrice - d.aliPrice, d.currency), C.accent],
    ];
    const cw = (W - PAD * 2) / 3;
    cells.forEach(([label, value, colour], i) => {
      const cx = PAD + cw * i;
      if (i > 0) {
        g.strokeStyle = C.rule;
        g.beginPath();
        g.moveTo(cx - 18, y - 12);
        g.lineTo(cx - 18, y + 46);
        g.stroke();
      }
      g.font = f(11, 'bold');
      g.fillStyle = C.muted;
      g.fillText(label, cx, y);
      g.font = f(36, 'bold');
      g.fillStyle = colour;
      g.fillText(value, cx, y + 42);
    });

    // --- verification line ----------------------------------------------------
    // The receipt names a real merchant, so it has to be checkable. Printing the
    // exact listing lets a skeptic reproduce the number instead of taking it on
    // trust — which is the whole difference between evidence and an accusation.
    if (d.aliUrl) {
      const vy = y + 96;
      rule(vy - 26);
      g.font = f(11, 'bold');
      g.fillStyle = C.muted;
      g.fillText('VERIFY', PAD, vy);
      g.font = f(15);
      g.fillStyle = C.text;
      g.fillText(ellipsize(g, d.aliUrl.replace(/^https?:\/\//, ''), W - PAD * 2 - 120), PAD + 90, vy);
    }

    // --- footer: the reproducibility stamp ------------------------------------
    const fy = H - PAD - 6;
    rule(fy - 26);

    // Only measured chips. No star rating unless the API gave one, no review count.
    const chips = [];
    if (d.sold) chips.push(String(d.sold));
    chips.push('matched by product photo');
    g.font = f(12);
    g.fillStyle = C.muted;
    g.fillText(chips.join('   ·   '), PAD, fy);

    const stamp = [
      d.shipTo ? 'ships to ' + d.shipTo : null,
      d.currency,
      d.capturedAt ? 'captured ' + d.capturedAt : null,
    ].filter(Boolean).join('  ·  ');
    g.font = f(12);
    g.fillStyle = C.dim;
    g.textAlign = 'right';
    g.fillText(stamp, W - PAD, fy);
    g.textAlign = 'left';

    return new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
  }

  return { render };
})();
