// bun test
// receipt.js runs as a classic (non-module) content script that assigns a
// global `var AliBadgeReceipt = (() => {...})()` and exposes only `render`.
// Every other function (money, wrap, ellipsize, drawThumb, ...) is private to
// that closure, so the only way to exercise them without changing the source
// is through render()'s own canvas 2D calls. We eval the file body inside a
// `new Function` with mocked `document` and `Image` params (shadowing the
// real globals used inside receipt.js) and record every canvas op, then
// assert on the recorded fillText/drawImage calls — this is the DOM mocking
// receipt.js itself needs, done the same "stub just enough of the browser"
// way lib.test.js stubs its own dependencies.
import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';

const SRC = readFileSync(new URL('./receipt.js', import.meta.url), 'utf8');

function makeContext(ops) {
  const ctx = { fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: 'left', textBaseline: 'alphabetic' };
  const record = (op) => (...args) => ops.push({ op, args, font: ctx.font, fillStyle: ctx.fillStyle, textAlign: ctx.textAlign });
  return Object.assign(ctx, {
    scale: record('scale'), save: record('save'), restore: record('restore'), clip: record('clip'),
    beginPath: record('beginPath'), moveTo: record('moveTo'), lineTo: record('lineTo'),
    arcTo: record('arcTo'), closePath: record('closePath'), stroke: record('stroke'), fill: record('fill'),
    fillRect: record('fillRect'), strokeRect: record('strokeRect'), drawImage: record('drawImage'),
    fillText: record('fillText'),
    // Deterministic stand-in for real glyph metrics: proportional to string
    // length and the numeric px size parsed out of the `font` string, which
    // is exactly what wrap()/ellipsize() need to make real wrapping decisions.
    measureText(t) {
      const m = /(\d+)px/.exec(ctx.font);
      const size = m ? Number(m[1]) : 12;
      return { width: String(t).length * size * 0.55 };
    },
  });
}

function makeDocument(ops, blobResult) {
  return {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error('receipt.js only creates canvas elements, got ' + tag);
      const ctx = makeContext(ops);
      return { width: 0, height: 0, getContext: () => ctx, toBlob: (cb, type) => cb(blobResult !== undefined ? blobResult : { size: 42, type }) };
    },
  };
}

// Mirrors loadImage()'s real contract: onload/onerror/8s-timeout race to
// resolve(img|null). Any src containing 'fail' simulates a load error; any
// falsy src is never reached because loadImage() short-circuits on !url.
class FakeImage {
  constructor() { this.width = 300; this.height = 300; }
  set src(url) {
    this._src = url;
    queueMicrotask(() => (url && url.includes('fail') ? this.onerror?.() : this.onload?.()));
  }
  get src() { return this._src; }
}

function load(ops = [], blobResult) {
  const factory = new Function('document', 'Image', SRC + '\nreturn AliBadgeReceipt;');
  return factory(makeDocument(ops, blobResult), FakeImage);
}

const texts = (ops) => ops.filter((o) => o.op === 'fillText').map((o) => o.args[0]);
const textOps = (ops) => ops.filter((o) => o.op === 'fillText');

const BASE = {
  storeHost: 'warmlydecor.com', storeTitle: 'Royal Vintage Cutlery Set', storePrice: 84.95, currency: 'USD',
  storeImage: 'https://cdn.shopify.com/x.jpg',
  aliTitle: '24pc Stainless Steel Cutlery Set', aliPrice: 9.72, aliImage: 'https://ae01.alicdn.com/y.jpg',
  aliUrl: 'https://aliexpress.com/item/123.html', sold: '2,000+ sold', markup: 774,
  priceBasis: 'matched listing', shipTo: 'US', capturedAt: '2026-07-28',
};

describe('render() — money formatting on the three-cell row', () => {
  test('renders known currency symbols and the store/ali/difference values', async () => {
    const ops = [];
    await load(ops).render(BASE);
    const t = texts(ops);
    expect(t).toContain('$84.95');
    expect(t).toContain('$9.72');
    expect(t).toContain('$75.23'); // 84.95 - 9.72, formatted through money()
  });

  test('falls back to "<amount> <currency>" for an unmapped currency', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, currency: 'XYZ' });
    expect(texts(ops)).toContain('84.95 XYZ');
  });

  test('renders bare amount with no currency label when currency is missing', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, currency: undefined });
    expect(texts(ops)).toContain('84.95');
  });

  test('renders "—" instead of a fabricated number when storePrice is not finite', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, storePrice: NaN, aliPrice: NaN, markup: undefined });
    const t = texts(ops);
    // storePrice, aliPrice and their difference are all unrenderable.
    expect(t.filter((x) => x === '—').length).toBeGreaterThanOrEqual(3);
  });
});

describe('render() — markup panel', () => {
  test('prints a signed percentage when markup is finite', async () => {
    const ops = [];
    await load(ops).render(BASE);
    expect(texts(ops)).toContain('+774%');
  });

  test('prints "—" instead of guessing when markup is not finite', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, markup: undefined });
    expect(texts(ops)).toContain('—');
    expect(texts(ops)).not.toContain('+774%');
  });

  test('renders the "Nx" ratio only when markup is finite and aliPrice is positive', async () => {
    const withRatio = [];
    await load(withRatio).render(BASE);
    // 84.95 / 9.72 = 8.74 -> rounds to 8.7x
    expect(texts(withRatio)).toContain('8.7×');

    const noAliPrice = [];
    await load(noAliPrice).render({ ...BASE, aliPrice: 0 });
    expect(texts(noAliPrice).some((t) => String(t).endsWith('×'))).toBe(false);

    const noMarkup = [];
    await load(noMarkup).render({ ...BASE, markup: undefined });
    expect(texts(noMarkup).some((t) => String(t).endsWith('×'))).toBe(false);
  });

  test('prints the price basis caveat, defaulting to "matched listing"', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, priceBasis: undefined });
    expect(texts(ops)).toContain('based on matched listing');
  });

  test('wraps a long note to at most 2 lines instead of overflowing the panel', async () => {
    const ops = [];
    const note = 'this caveat is deliberately long enough that it must wrap across several lines of the narrow markup panel and then some more words';
    await load(ops).render({ ...BASE, note });
    const accentLines = textOps(ops).filter((o) => o.fillStyle === '#ff5a4d' && o.font.includes('14px'));
    expect(accentLines.length).toBe(2);
  });

  test('omits the note entirely when absent', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, note: undefined });
    const accentLines = textOps(ops).filter((o) => o.font.includes('14px'));
    expect(accentLines.length).toBe(0);
  });

  test('always prints the "excludes shipping" disclosure', async () => {
    const ops = [];
    await load(ops).render(BASE);
    expect(texts(ops)).toContain('excludes shipping');
  });
});

describe('render() — thumbnails: never fabricate a missing photo', () => {
  test('draws the store host and "aliexpress" as thumbnail labels', async () => {
    const ops = [];
    await load(ops).render(BASE);
    expect(texts(ops)).toContain('WARMLYDECOR.COM');
    expect(texts(ops)).toContain('ALIEXPRESS');
  });

  test('defaults the store label to "STORE" when storeHost is missing', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, storeHost: undefined });
    expect(texts(ops)).toContain('STORE');
  });

  test('draws a labelled placeholder, not a fabricated image, when a URL is absent', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, storeImage: undefined, aliImage: undefined });
    expect(texts(ops).filter((t) => t === 'image unavailable').length).toBe(2);
    expect(ops.some((o) => o.op === 'drawImage')).toBe(false);
  });

  test('draws a labelled placeholder when an image URL fails to load', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, storeImage: 'https://cdn.shopify.com/fail.jpg', aliImage: 'https://ae01.alicdn.com/fail.jpg' });
    expect(texts(ops).filter((t) => t === 'image unavailable').length).toBe(2);
    expect(ops.some((o) => o.op === 'drawImage')).toBe(false);
  });

  test('draws the image (no placeholder) once it loads successfully', async () => {
    const ops = [];
    await load(ops).render(BASE);
    expect(texts(ops)).not.toContain('image unavailable');
    expect(ops.some((o) => o.op === 'drawImage')).toBe(true);
  });

  test('ellipsizes an overly long store/ali title instead of overflowing the column', async () => {
    const ops = [];
    const longTitle = 'A '.repeat(200) + 'Extremely Long Product Title That Cannot Possibly Fit';
    await load(ops).render({ ...BASE, storeTitle: longTitle });
    expect(texts(ops).some((t) => typeof t === 'string' && t.endsWith('…'))).toBe(true);
  });
});

describe('render() — verification line', () => {
  test('prints the ali URL with the scheme stripped when present', async () => {
    const ops = [];
    await load(ops).render(BASE);
    expect(texts(ops)).toContain('aliexpress.com/item/123.html');
    expect(texts(ops)).toContain('VERIFY');
  });

  test('omits the VERIFY line entirely when aliUrl is absent', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, aliUrl: undefined });
    expect(texts(ops)).not.toContain('VERIFY');
  });
});

describe('render() — footer chips and stamp', () => {
  test('includes the sold count and the fixed "matched by product photo" chip', async () => {
    const ops = [];
    await load(ops).render(BASE);
    expect(texts(ops)).toContain('2,000+ sold   ·   matched by product photo');
  });

  test('drops the sold chip entirely when sold is falsy', async () => {
    const ops = [];
    await load(ops).render({ ...BASE, sold: undefined });
    expect(texts(ops)).toContain('matched by product photo');
  });

  test('builds the stamp from only the parts that are present', async () => {
    const full = [];
    await load(full).render(BASE);
    expect(texts(full)).toContain('ships to US  ·  USD  ·  captured 2026-07-28');

    const partial = [];
    await load(partial).render({ ...BASE, shipTo: undefined, capturedAt: undefined });
    expect(texts(partial)).toContain('USD');

    const empty = [];
    await load(empty).render({ ...BASE, shipTo: undefined, currency: undefined, capturedAt: undefined });
    // An entirely empty stamp is still a legal (empty-string) fillText call, not a crash.
    expect(texts(empty)).toContain('');
  });
});

describe('render() — overall contract', () => {
  test('resolves to whatever canvas.toBlob() produces', async () => {
    const blob = await load([], { size: 123, type: 'image/png' }).render(BASE);
    expect(blob).toEqual({ size: 123, type: 'image/png' });
  });

  test('resolves to null when canvas.toBlob() itself yields null (real-world canvas failure)', async () => {
    const blob = await load([], null).render(BASE);
    expect(blob).toBe(null);
  });

  test('does not throw on a mostly-empty data object', async () => {
    await expect(load([]).render({})).resolves.toBeDefined();
  });

  test('rejects rather than silently rendering when given no data object at all', async () => {
    await expect(load([]).render(undefined)).rejects.toThrow();
  });
});
