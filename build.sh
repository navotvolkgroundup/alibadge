#!/usr/bin/env bash
# Web Store / load-unpacked bundle. Ships ONLY what the extension runs — the labelled set,
# harnesses and tests stay out, both to keep the review surface small and because
# labelset/ contains measurement records that are nobody else's business.
set -euo pipefail
cd "$(dirname "$0")"

command -v bun >/dev/null && { bun test src; bunx playwright test; }

OUT="dist/alibadge-$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])').zip"
# Keep dist/store — the Web Store screenshots live there and are slow to regenerate.
rm -f dist/*.zip && mkdir -p dist
zip -qr "$OUT" \
  manifest.json rules.json options.html options.js PRIVACY.md \
  src/lib.js src/worker.js src/content.js src/receipt.js \
  icons \
  -x '*.test.js'

python3 - "$OUT" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
print(f'{sys.argv[1]}  ({sum(i.file_size for i in z.infolist())//1024} KB uncompressed)')
for n in sorted(names): print('  ', n)
bad = [n for n in names if 'test' in n or n.startswith('labelset/')]
assert not bad, f'must not ship: {bad}'
print('\nOK — no tests or measurement records in the bundle')
PY
