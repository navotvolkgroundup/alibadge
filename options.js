// Consent is a single boolean in chrome.storage.local, read by lookup() before any
// network call. No inline script: MV3's default CSP forbids it.
const box = document.getElementById('consent');
const state = document.getElementById('state');
const panel = document.querySelector('.consent-box');

function paint(on) {
  box.checked = on;
  panel.classList.toggle('warn', !on);
  state.textContent = on
    ? 'Enabled. Visit a Shopify product page — most pages stay silent by design.'
    : 'Disabled. Nothing is uploaded.';
}

// Tolerate being opened outside the extension (file://, a static server, a screenshot
// harness): chrome.storage is absent there and an unhandled throw leaves the panel
// stuck on "checking…".
const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;

if (store) store.get('consent').then((r) => paint(r.consent === true), () => paint(false));
else {
  paint(false);
  state.textContent = 'Open this from the extension to change the setting.';
}

box.addEventListener('change', async () => {
  if (!store) { box.checked = false; return; }
  const on = box.checked;
  await store.set({ consent: on });
  // Turning it OFF drops everything already fetched, so a withdrawal is not merely
  // prospective — the cached marketplace results go too.
  if (!on) {
    const keys = Object.keys(await store.get(null)).filter((k) => k.startsWith('c:'));
    if (keys.length) await store.remove(keys);
  }
  paint(on);
});
