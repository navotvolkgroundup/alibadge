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

chrome.storage.local.get('consent').then((r) => paint(r.consent === true));

box.addEventListener('change', async () => {
  const on = box.checked;
  await chrome.storage.local.set({ consent: on });
  // Turning it OFF drops everything already fetched, so a withdrawal is not merely
  // prospective — the cached marketplace results go too.
  if (!on) {
    const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('c:'));
    if (keys.length) await chrome.storage.local.remove(keys);
  }
  paint(on);
});
